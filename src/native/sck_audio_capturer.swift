import Foundation
import ScreenCaptureKit
import AVFoundation

// MARK: - Binary Transport Header
struct FrameHeader {
    let payloadLength: UInt32
    let timestampNs: UInt64
    let sequenceNum: UInt32

    var data: Data {
        var bytes = Data()
        var lenBE = payloadLength.bigEndian
        var timeBE = timestampNs.bigEndian
        var seqBE = sequenceNum.bigEndian

        bytes.append(Data(bytes: &lenBE, count: 4))
        bytes.append(Data(bytes: &timeBE, count: 8))
        bytes.append(Data(bytes: &seqBE, count: 4))
        return bytes
    }
}

// MARK: - Diagnostic Logging Helper (stderr JSON)
func logDiag(status: String, level: String = "info", message: String, extra: [String: Any] = [:]) {
    var payload: [String: Any] = [
        "timestamp": ISO8601DateFormatter().string(from: Date()),
        "status": status,
        "level": level,
        "msg": message,
        "component": "SCKAudioCapturer"
    ]
    for (k, v) in extra {
        payload[k] = v
    }
    if let jsonData = try? JSONSerialization.data(withJSONObject: payload),
       let jsonStr = String(data: jsonData, encoding: .utf8) {
        FileHandle.standardError.write(Data((jsonStr + "\n").utf8))
    }
}

// MARK: - Stream Delegate Handler (Self-Healing & Auto-Reconnecting)
class StreamDelegateHandler: NSObject, SCStreamDelegate {
    private var isHandlingStop = false

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard !isHandlingStop else { return }
        isHandlingStop = true
        logDiag(status: "stream-stopped-error", level: "error", message: "SCStream stopped with error", extra: ["error": error.localizedDescription])

        Task {
            logDiag(status: "stream-reconnecting", level: "warn", message: "Attempting self-healing stream restart via primary display audio loopback...")
            await SCKAudioCapturerMain.restartStreamWithDisplayFallback()
            self.isHandlingStop = false
        }
    }
}

// MARK: - Dummy Screen Stream Output Handler (Strongly Retained)
class DummyScreenStreamOutputHandler: NSObject, SCStreamOutput {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // Discard video sample buffers safely to satisfy macOS ScreenCaptureKit pipeline requirements
    }
}

// MARK: - ScreenCaptureKit Stream Audio Output Handler (Strongly Retained)
class AudioStreamOutputHandler: NSObject, SCStreamOutput {
    private var sequenceNum: UInt32 = 0
    private var droppedFramesCount: UInt64 = 0
    private var firstFrameReported = false
    private let stdoutHandle = FileHandle.standardOutput
    private let lock = NSLock()

    // Public metrics & state
    var isDiagnosticOnly = false
    private(set) var callbackCount: UInt64 = 0
    private(set) var pcmFramesCount: UInt64 = 0
    private(set) var pcmBytesCount: UInt64 = 0
    private(set) var nonZeroFramesCount: UInt64 = 0
    private(set) var lastCallbackTime: Date = Date()
    private(set) var lastRawRms: Double = 0.0
    private(set) var lastConvertedRms: Double = 0.0

    // 16kHz mono converter setup
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

    private func calculateRawRMS(sampleBuffer: CMSampleBuffer) -> Double {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return 0.0 }
        let length = CMBlockBufferGetDataLength(blockBuffer)
        guard length > 0 else { return 0.0 }

        var dataPointer: UnsafeMutablePointer<Int8>?
        CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: nil, dataPointerOut: &dataPointer)
        guard let ptr = dataPointer else { return 0.0 }

        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return 0.0 }
        guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else { return 0.0 }

        var sumSquares: Double = 0.0
        var sampleCount = 0

        if asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0 {
            let floatPtr = ptr.withMemoryRebound(to: Float32.self, capacity: length / 4) { $0 }
            sampleCount = length / 4
            for i in 0..<sampleCount {
                let val = Double(floatPtr[i])
                sumSquares += val * val
            }
        } else {
            let int16Ptr = ptr.withMemoryRebound(to: Int16.self, capacity: length / 2) { $0 }
            sampleCount = length / 2
            for i in 0..<sampleCount {
                let val = Double(int16Ptr[i]) / 32768.0
                sumSquares += val * val
            }
        }

        return sampleCount > 0 ? sqrt(sumSquares / Double(sampleCount)) : 0.0
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }

        let now = Date()
        lock.lock()
        callbackCount += 1
        lastCallbackTime = now
        lock.unlock()

        let rawRms = calculateRawRMS(sampleBuffer: sampleBuffer)

        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        let currentInputFormat = AVAudioFormat(cmAudioFormatDescription: formatDesc)
        
        if converter == nil || inputFormat != currentInputFormat {
            inputFormat = currentInputFormat
            converter = AVAudioConverter(from: currentInputFormat, to: outputFormat)
            logDiag(status: "format-configured", level: "info", message: "Audio format configured", extra: [
                "sampleRate": currentInputFormat.sampleRate,
                "channels": currentInputFormat.channelCount
            ])
        }

        guard let converter = converter else { return }

        let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
        guard numSamples > 0 else { return }

        guard let inputPCMBuffer = AVAudioPCMBuffer(pcmFormat: currentInputFormat, frameCapacity: AVAudioFrameCount(numSamples)) else { return }
        inputPCMBuffer.frameLength = AVAudioFrameCount(numSamples)

        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: inputPCMBuffer.mutableAudioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )

        guard status == noErr else { return }

        let ratio = 16000.0 / currentInputFormat.sampleRate
        let outputCapacity = AVAudioFrameCount(Double(numSamples) * ratio) + 100
        guard let outputPCMBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outputCapacity) else { return }

        var error: NSError?
        var isExhausted = false
        converter.convert(to: outputPCMBuffer, error: &error) { packetCount, outStatus in
            if isExhausted {
                outStatus.pointee = .noDataNow
                return nil
            }
            isExhausted = true
            outStatus.pointee = .haveData
            return inputPCMBuffer
        }

        if let error = error {
            logDiag(status: "converter-error", level: "error", message: "AVAudioConverter failed", extra: ["error": error.localizedDescription])
            return
        }

        guard outputPCMBuffer.frameLength > 0, let int16Data = outputPCMBuffer.int16ChannelData else { return }

        let frameSamplesCount = Int(outputPCMBuffer.frameLength)
        let byteCount = frameSamplesCount * 2
        let pcmBufferPtr = int16Data[0]
        let pcmData = Data(bytes: pcmBufferPtr, count: byteCount)

        // Calculate converted RMS and Peak Amplitude
        var sumSquares: Double = 0
        var maxPeak: Int16 = 0
        for i in 0..<frameSamplesCount {
            let sample = pcmBufferPtr[i]
            let absSample = abs(Int32(sample))
            if absSample > maxPeak { maxPeak = Int16(absSample) }
            let val = Double(sample) / 32768.0
            sumSquares += val * val
        }
        let convertedRms = frameSamplesCount > 0 ? sqrt(sumSquares / Double(frameSamplesCount)) : 0.0

        lock.lock()
        sequenceNum += 1
        pcmFramesCount += 1
        pcmBytesCount += UInt64(pcmData.count)
        if convertedRms > 0.001 || maxPeak > 50 {
            nonZeroFramesCount += 1
        }
        lastRawRms = rawRms
        lastConvertedRms = convertedRms
        lock.unlock()

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let timestampNs = UInt64(max(0, pts.seconds * 1_000_000_000))

        if !firstFrameReported || sequenceNum <= 5 || sequenceNum % 100 == 0 {
            if !firstFrameReported { firstFrameReported = true }
            logDiag(status: "pcm-frame", level: "info", message: "Audio frame metrics", extra: [
                "seq": sequenceNum,
                "bytes": pcmData.count,
                "rawRms": (rawRms * 1000).rounded() / 1000,
                "convertedRms": (convertedRms * 1000).rounded() / 1000,
                "peak": maxPeak,
                "timestampNs": timestampNs
            ])
        }

        if isDiagnosticOnly {
            return
        }

        let header = FrameHeader(
            payloadLength: UInt32(pcmData.count),
            timestampNs: timestampNs,
            sequenceNum: sequenceNum
        )

        var packet = header.data
        packet.append(pcmData)

        do {
            try stdoutHandle.write(contentsOf: packet)
        } catch {
            droppedFramesCount += 1
            logDiag(status: "write-pressure", level: "warn", message: "Dropped frame due to stdout write pressure", extra: [
                "droppedFrames": droppedFramesCount,
                "error": error.localizedDescription
            ])
        }
    }
}

// MARK: - App Listing Helper
func listShareableApps() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        var apps: [[String: Any]] = []
        for app in content.applications {
            if !app.applicationName.isEmpty {
                apps.append([
                    "pid": app.processID,
                    "bundleIdentifier": app.bundleIdentifier,
                    "name": app.applicationName
                ])
            }
        }
        let output: [String: Any] = ["success": true, "apps": apps]
        if let jsonData = try? JSONSerialization.data(withJSONObject: output),
           let str = String(data: jsonData, encoding: .utf8) {
            print(str)
        }
    } catch {
        let errResp: [String: Any] = [
            "success": false,
            "code": "SCREEN_CAPTURE_PERMISSION_DENIED",
            "error": "Screen & System Audio Recording permission is required. Enable OpenCluely in System Settings -> Privacy & Security -> Screen & System Audio Recording."
        ]
        if let jsonData = try? JSONSerialization.data(withJSONObject: errResp),
           let str = String(data: jsonData, encoding: .utf8) {
            print(str)
        }
    }
}

// MARK: - Main Execution Entrypoint
@main
struct SCKAudioCapturerMain {
    // CRITICAL FIX: Strong static references to prevent Swift ARC deallocation of stream and output delegates!
    static var stream: SCStream?
    static var streamDelegate: StreamDelegateHandler?
    static var audioHandler: AudioStreamOutputHandler?
    static var dummyScreenHandler: DummyScreenStreamOutputHandler?
    static var audioQueue: DispatchQueue?
    static var videoQueue: DispatchQueue?
    static var dispatchTimerSource: DispatchSourceTimer?
    static var startTime: Date = Date()
    static var isReconnecting = false

    static func restartStreamWithDisplayFallback() async {
        guard !isReconnecting else { return }
        isReconnecting = true
        defer { isReconnecting = false }

        do {
            stream = nil

            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { return }

            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.sampleRate = 16000
            config.channelCount = 1
            config.excludesCurrentProcessAudio = true
            config.width = 64
            config.height = 64
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

            let newStream = SCStream(filter: filter, configuration: config, delegate: streamDelegate)
            stream = newStream

            if audioHandler == nil { audioHandler = AudioStreamOutputHandler() }
            if dummyScreenHandler == nil { dummyScreenHandler = DummyScreenStreamOutputHandler() }
            if audioQueue == nil { audioQueue = DispatchQueue(label: "com.opencluely.sck.audio", qos: .userInitiated) }
            if videoQueue == nil { videoQueue = DispatchQueue(label: "com.opencluely.sck.video", qos: .utility) }

            try newStream.addStreamOutput(audioHandler!, type: .audio, sampleHandlerQueue: audioQueue!)
            try newStream.addStreamOutput(dummyScreenHandler!, type: .screen, sampleHandlerQueue: videoQueue!)

            try await newStream.startCapture()

            logDiag(status: "SCK_RECONNECTED", level: "info", message: "ScreenCaptureKit stream successfully reconnected via primary display loopback")
        } catch {
            logDiag(status: "reconnect-failed", level: "error", message: "Failed to reconnect ScreenCaptureKit stream", extra: ["error": error.localizedDescription])
        }
    }

    static func main() {
        let args = CommandLine.arguments

        if args.contains("--list-apps") {
            Task {
                await listShareableApps()
                exit(0)
            }
            dispatchMain()
            return
        }

        let isDiagnostic = args.contains("--diagnostic-metrics")
        let forceDisplayMode = args.contains("--mode") && (args.firstIndex(of: "--mode").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } == "display")

        logDiag(status: "initializing", level: "info", message: "Starting ScreenCaptureKit audio capturer...", extra: [
            "diagnosticMetrics": isDiagnostic,
            "forceDisplayMode": forceDisplayMode
        ])

        var targetPID: pid_t? = nil
        if let pidIdx = args.firstIndex(of: "--pid"), pidIdx + 1 < args.count {
            if let pid = pid_t(args[pidIdx + 1]), pid > 0 {
                targetPID = pid
            }
        }

        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

                let totalDisplays = content.displays.count
                let totalApps = content.applications.count
                let totalWindows = content.windows.count

                var matchingAppsCount = 0
                var matchingWindowsCount = 0
                var targetApp: SCRunningApplication? = nil

                if let pid = targetPID {
                    let matchingApps = content.applications.filter { $0.processID == pid }
                    matchingAppsCount = matchingApps.count
                    targetApp = matchingApps.first

                    let matchingWindows = content.windows.filter { $0.owningApplication?.processID == pid }
                    matchingWindowsCount = matchingWindows.count
                }

                logDiag(status: "content-inventory", level: "info", message: "ScreenCaptureKit shareable content inventory", extra: [
                    "displays": totalDisplays,
                    "applications": totalApps,
                    "windows": totalWindows,
                    "targetPid": targetPID ?? 0,
                    "targetBundleId": targetApp?.bundleIdentifier ?? "N/A",
                    "matchingApps": matchingAppsCount,
                    "matchingWindows": matchingWindowsCount
                ])

                let filter: SCContentFilter
                let filterMethodUsed: String

                if !forceDisplayMode, let tApp = targetApp, let display = content.displays.first {
                    filterMethodUsed = "display-including-app"
                    logDiag(status: "source-selected", level: "info", message: "Targeting specific application", extra: [
                        "name": tApp.applicationName,
                        "pid": tApp.processID,
                        "bundleIdentifier": tApp.bundleIdentifier,
                        "filterMethod": filterMethodUsed,
                        "matchingWindows": matchingWindowsCount
                    ])
                    filter = SCContentFilter(display: display, including: [tApp], exceptingWindows: [])
                } else if let display = content.displays.first {
                    filterMethodUsed = "display-excluding-apps"
                    logDiag(status: "source-selected", level: "info", message: "Targeting primary display audio loopback", extra: [
                        "filterMethod": filterMethodUsed,
                        "displayID": display.displayID
                    ])
                    filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                } else {
                    logDiag(status: "error", level: "error", message: "No suitable display or application found for capture")
                    exit(1)
                }

                let config = SCStreamConfiguration()
                config.capturesAudio = true
                config.sampleRate = 16000
                config.channelCount = 1
                config.excludesCurrentProcessAudio = true

                logDiag(status: "stream-config", level: "info", message: "ScreenCaptureKit stream configuration", extra: [
                    "capturesAudio": config.capturesAudio,
                    "sampleRate": config.sampleRate,
                    "channelCount": config.channelCount,
                    "excludesCurrentProcessAudio": config.excludesCurrentProcessAudio
                ])

                // Low-overhead dummy video configuration (1 FPS, 64x64) to keep ScreenCaptureKit video queue healthy
                config.width = 64
                config.height = 64
                config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

                // Assign to static properties so Swift ARC retains objects strongly!
                audioHandler = AudioStreamOutputHandler()
                audioHandler?.isDiagnosticOnly = isDiagnostic
                dummyScreenHandler = DummyScreenStreamOutputHandler()
                streamDelegate = StreamDelegateHandler()

                let newStream = SCStream(filter: filter, configuration: config, delegate: streamDelegate)
                stream = newStream

                let aQueue = DispatchQueue(label: "com.opencluely.sck.audio", qos: .userInitiated)
                let vQueue = DispatchQueue(label: "com.opencluely.sck.video", qos: .utility)
                audioQueue = aQueue
                videoQueue = vQueue
                
                try newStream.addStreamOutput(audioHandler!, type: .audio, sampleHandlerQueue: aQueue)
                try newStream.addStreamOutput(dummyScreenHandler!, type: .screen, sampleHandlerQueue: vQueue)

                try await newStream.startCapture()

                // EXPLICIT HANDSHAKE: Emit SCK_READY status
                logDiag(status: "SCK_READY", level: "info", message: "ScreenCaptureKit stream started and output callbacks registered", extra: [
                    "filterMethod": filterMethodUsed
                ])

                // Setup 1-second periodic diagnostic timer using DispatchSourceTimer (compatible with dispatchMain)
                startTime = Date()
                let timerSource = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
                timerSource.schedule(deadline: .now() + 1.0, repeating: 1.0)
                timerSource.setEventHandler {
                    guard let handler = audioHandler else { return }
                    let elapsed = Date().timeIntervalSince(startTime)
                    let ageMs = Int(Date().timeIntervalSince(handler.lastCallbackTime) * 1000)

                    logDiag(status: "audio-callback-metrics", level: "info", message: "Periodic audio health metrics", extra: [
                        "elapsedSec": Int(elapsed),
                        "callbacks": handler.callbackCount,
                        "pcmFrames": handler.pcmFramesCount,
                        "pcmBytes": handler.pcmBytesCount,
                        "nonZeroFrames": handler.nonZeroFramesCount,
                        "rawRms": (handler.lastRawRms * 1000).rounded() / 1000,
                        "convertedRms": (handler.lastConvertedRms * 1000).rounded() / 1000,
                        "lastCallbackAgeMs": ageMs
                    ])

                    if ageMs > 2000 && handler.callbackCount > 0 {
                        logDiag(status: "AUDIO_CALLBACK_STALLED", level: "warn", message: "No SCK audio sample buffers received in past 2.0 seconds", extra: [
                            "ageMs": ageMs,
                            "totalCallbacks": handler.callbackCount
                        ])
                    }
                }
                dispatchTimerSource = timerSource
                timerSource.resume()

            } catch {
                logDiag(status: "permission-denied", level: "error", message: "ScreenCaptureKit permission or startup error", extra: ["error": error.localizedDescription])
                exit(1)
            }
        }

        let sigInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        sigInt.setEventHandler { exit(0) }
        sigInt.resume()

        let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sigTerm.setEventHandler { exit(0) }
        sigTerm.resume()

        dispatchMain()
    }
}
