const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, globalShortcut, session, ipcMain, dialog } = require("electron");
const ollamaService = require("./src/services/ollama.service");
const callBriefManager = require("./src/managers/call-brief.manager");

// ── Resolve a stable .env location ──
// In packaged builds process.cwd() is unstable and frequently read-only
// (NSIS install dir, AppImage mount, .app bundle), so the canonical config
// lives in Electron's userData directory. We still prefer an existing
// project-local .env in development (npm start) so the dev workflow is
// unchanged. Both onboarding (FirstRunManager) and persistEnvUpdates() write
// to this same path so settings survive restarts on every platform.
function resolveEnvPath() {
  try {
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    const projectEnv = path.join(process.cwd(), ".env");
    // Prefer a project .env only when it already exists and userData has none
    // (i.e. a developer running from the repo). Otherwise use userData.
    if (!fs.existsSync(userDataEnv) && fs.existsSync(projectEnv)) {
      return projectEnv;
    }
    return userDataEnv;
  } catch (_) {
    // On packaged macOS builds, process.cwd() may be inside a read-only .app
    // bundle. Fall back to userData so .env writes never fail.
    try {
      return path.join(app.getPath("userData"), ".env");
    } catch (e2) {
      return path.join(process.cwd(), ".env");
    }
  }
}
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });

// Format a value for a single .env line. Newlines are collapsed to spaces and
// backslashes are kept verbatim (doubling them corrupts Windows paths on the
// next load). Values containing whitespace, a double-quote, or a leading '#'
// are wrapped in single quotes so dotenv parses them as one token — essential
// for Whisper commands like:  "C:\Users\Jane Doe\...\python.exe" -m whisper
function formatEnvValue(raw) {
  const v = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (!/[\s"#]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value already contains a single quote — fall back to double quotes.
  return `"${v.replace(/"/g, '\\"')}"`;
}

// ── Linux GPU process crash workaround ──
// On many Linux setups (Wayland, X11 without GPU drivers, Docker, headless,
// or systems with broken Mesa/NVIDIA stacks), Chromium's GPU process crashes
// on startup with:
//   FATAL:gpu_data_manager_impl_private.cc(448)] GPU process isn't usable.
// This kills the entire app and can leave orphan helper processes that
// exhaust the X11 client limit, producing "Maximum number of clients reached".
//
// Disabling hardware acceleration and the GPU subprocess forces Chromium to
// render via the CPU (SwiftShader). OpenCluely's UI is light enough that
// this is imperceptible, and it eliminates the GPU crash entirely.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // On X11 only; harmless on Wayland. Prevents Chromium from spawning a
  // compositor process that adds another X11 client.
  app.commandLine.appendSwitch("in-process-gpu");
}

// Keep Chromium network noise out of the terminal; app-level logs still go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const FirstRunManager = require("./src/core/first-run");

// ── Global crash guard ──
// The speech path spawns external processes (Whisper CLI, and on macOS/Linux
// the sox/rec/arecord recorders via node-record-lpcm16). A missing recorder
// binary makes that library emit an 'error' on its child process with no
// listener, which would otherwise become an uncaughtException and quit the
// entire app the moment the user clicks the mic. We log and stay alive — the
// speech service surfaces a friendly status to the UI instead.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

// Services
// Screen capture (image-based)
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    this.activeSkill = "dsa";
    this.codingLanguage = "cpp";
    this.speechAvailable = false;

    logger.info("[BOOT] OpenCluely application startup", {
      appPath: app.getAppPath(),
      cwd: process.cwd(),
      commit: "9754c21",
      mainFile: __filename,
      preloadFile: path.join(__dirname, "preload.js")
    });

    // Utterance coalescing: VAD emits a transcript per natural pause, but a
    // single spoken question can still arrive as a few fragments (mid-thought
    // pauses). We buffer fragments and debounce so one question yields one LLM
    // call instead of several slow, half-answered ones.
    this._utteranceBuffer = "";
    this._utteranceTimer = null;
    this._utteranceDispatchInFlight = false;
    this._utteranceCoalesceMs = 800;

    // First-run onboarding: detects missing .env / API key and triggers
    // a settings-window prompt on first launch so users don't have to
    // dig through docs to figure out they need a Gemini API key.
    this.firstRunManager = new FirstRunManager({
      logger: logger,
      // .env and the sentinel both live in userData so they survive cwd
      // changes and read-only install dirs (the app may be launched from
      // any directory). ENV_PATH is the same file dotenv loaded at startup
      // and that persistEnvUpdates() writes to.
      envPath: ENV_PATH,
      sentinelPath: path.join(app.getPath("userData"), ".opencluely-firstrun-completed"),
    });
    // Lazily-initialised in getWhisperInstaller() so tests can mock
    // the constructor without polluting main-process startup.
    this._whisperInstaller = null;
    this.isFirstRun = false;
    this.aiProvider = 'ollama'; // 'ollama' (default) | 'gemini'

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "OpenCluely" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.copilotState = "IDLE";

    this.setupStealth();
    this.setupEventHandlers();
  }

  setCopilotState(state, statusText = "") {
    this.copilotState = state;
    logger.info(`[CALL] state=${state} text="${statusText}"`);
    windowManager.broadcastToAllWindows("copilot-status", {
      state: this.copilotState,
      active: this.copilotState === "ACTIVE",
      statusText: statusText
    });
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set real app identity
    if (app && typeof app.setName === 'function') {
      app.setName("OpenCluely");
    }
    process.title = "OpenCluely";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }

        if (this.isReady) {
          windowManager.showAllWindows();
        }
      } catch (error) {
        logger.error("Failed to focus existing instance", {
          error: error.message,
        });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) {
      logger.debug("onAppReady skipped: already starting or ready");
      return;
    }
    this.starting = true;

    app.setName("OpenCluely");
    process.title = "OpenCluely";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupPermissions();
      this.setupNetworkConfiguration();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // First-run onboarding: ensure .env exists and read status once
      // so we can decide whether to defer showing the main overlay.
      let status;
      try {
        this.firstRunManager.ensureEnv();
        status = this.firstRunManager.getStatus();
        this.isFirstRun = status.needsOnboarding;
        logger.info("First-run status", status);
      } catch (e) {
        logger.warn("First-run check failed", { error: e.message });
        status = { needsOnboarding: false };
        this.isFirstRun = false;
      }
      const isFirstRun = status.needsOnboarding;

      await windowManager.initializeWindows({ showMainWindow: !isFirstRun });
      this.setupGlobalShortcuts();

      this.starting = false;
      this.isReady = true;

      // Launch the onboarding wizard if this is the first run.
      if (this.isFirstRun) {
        // Defer slightly so all windows finish loading before we pop
        // the wizard on top of them.
        setTimeout(() => {
          try {
            windowManager.showOnboarding();
            windowManager.broadcastToAllWindows("first-run", status);
            logger.info("First-run onboarding: wizard opened");
          } catch (e) {
            logger.warn("Could not open first-run onboarding window", {
              error: e.message
            });
            // Fallback to legacy settings prompt
            try { this.showSettings(); } catch (_) { /* ignore */ }
          }
        }, 800);
      } else {
        // Already configured — mark completed so we never nag again.
        this.firstRunManager.markCompleted();
      }

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupNetworkConfiguration() {
    // Configure session to handle network requests better
    const ses = session.defaultSession;
    
    // Allow HTTPS requests to Google APIs
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.includes('generativelanguage.googleapis.com')) {
        const platformUA = process.platform === 'darwin'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36'
          : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36';
        details.requestHeaders['User-Agent'] = platformUA;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    
    // Handle certificate errors for Google APIs
    ses.setCertificateVerifyProc((request, callback) => {
      if (request.hostname === 'generativelanguage.googleapis.com') {
        callback(0); // Trust Google's certificates
      } else {
        callback(-2); // Use default verification
      }
    });
    
    logger.debug('Network configuration applied for Gemini API');
  }

  setupPermissions() {
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const allowedPermissions = ["microphone", "camera", "display-capture", "media"];
        const granted = allowedPermissions.includes(permission);

        logger.debug("Permission request", { permission, granted });
        callback(granted);
      }
    );

    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission) => {
        const allowedPermissions = ["microphone", "camera", "display-capture", "media"];
        return allowedPermissions.includes(permission);
      }
    );

    if (process.platform === 'darwin') {
      try {
        const { systemPreferences } = require('electron');
        if (systemPreferences && typeof systemPreferences.askForMediaAccess === 'function') {
          systemPreferences.askForMediaAccess('microphone').then((granted) => {
            logger.info('macOS microphone permission prompt result', { granted });
          }).catch((err) => {
            logger.warn('macOS microphone permission prompt check failed', { error: err.message });
          });
        }
      } catch (e) {}
    }
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.triggerScreenshotOCR(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+C": () => windowManager.switchToWindow("chat"),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+,": () => windowManager.showSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "Alt+R": () => this.toggleSpeechRecognition(),
      "CommandOrControl+Shift+T": () => windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
      // Emergency and Quit Shortcuts (Main Process Native)
      "Ctrl+Alt+Cmd+Escape": () => this.triggerEmergencyEscape(),
      "Control+Option+Command+Escape": () => this.triggerEmergencyEscape(),
      "Ctrl+Alt+Cmd+Q": () => this.cleanQuit(),
      "Control+Option+Command+Q": () => this.cleanQuit(),
      // Context-sensitive shortcuts based on interaction mode
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      try {
        const success = globalShortcut.register(accelerator, handler);
        logger.debug("Global shortcut registered", { accelerator, success });
      } catch (err) {
        logger.warn("Failed to register global shortcut", { accelerator, error: err.message });
      }
    });
  }

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-started");
      });
    });

    speechService.on("recording-stopped", () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-stopped");
      });
    });

    speechService.on("transcription", (text) => {
      this.handleTranscriptionFragment(text);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
      // Also broadcast availability specifically
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-availability", { available: this.speechAvailable });
      });
    });

    speechService.on("error", (error) => {
      // In error, still compute availability
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error, available: this.speechAvailable });
      });
    });
  }

  setupIPCHandlers() {
  ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());
  ipcMain.handle("list-displays", () => captureService.listDisplays());
  ipcMain.handle("capture-area", (event, options) => captureService.captureAndProcess(options));
    
    // Provide reliable clipboard write via main process
    ipcMain.handle("copy-to-clipboard", (event, text) => {
      try {
        const { clipboard } = require("electron");
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (e) {
        logger.error("Failed to write to clipboard", { error: e.message });
        return false;
      }
    });
    
    ipcMain.handle("get-speech-availability", () => {
      return speechService.isAvailable ? speechService.isAvailable() : false;
    });

    ipcMain.handle("start-speech-recognition", (event) => {
      return this._handleSpeechRequest(event, 'start');
    });

    ipcMain.handle("stop-speech-recognition", (event) => {
      return this._handleSpeechRequest(event, 'stop');
    });

    // Raw PCM audio captured by the renderer's Web Audio API (Windows/macOS Whisper path)
    ipcMain.on("audio-chunk", (_event, data) => {
      if (!data || !data.buffer) return;

      const pcm = Buffer.from(data.buffer);

      // During built-in-microphone Live Call mode, send renderer PCM
      // directly into the persistent streaming Whisper worker.
      if (this.liveMicCaptureActive) {
        const streamingTranscriptionService =
          require("./src/services/streaming-transcription.service");

        const accepted = streamingTranscriptionService.feedAudioFrame(pcm);

        if (accepted) {
          this.liveMicPcmFrames = (this.liveMicPcmFrames || 0) + 1;
          this.liveMicPcmBytes = (this.liveMicPcmBytes || 0) + pcm.length;
          this.liveMicLastFrameAt = Date.now();

          let sumSquares = 0;
          const samples = Math.floor(pcm.length / 2);

          for (let i = 0; i < samples; i++) {
            const v = pcm.readInt16LE(i * 2) / 32768;
            sumSquares += v * v;
          }

          const rms = samples
            ? Math.sqrt(sumSquares / samples)
            : 0;

          this.liveMicLastRms = rms;

          if (this.liveMicPcmFrames === 1 ||
              this.liveMicPcmFrames % 25 === 0) {
            logger.info(
              `[LIVE-MIC] frames=${this.liveMicPcmFrames} bytes=${this.liveMicPcmBytes} rms=${rms.toFixed(4)}`
            );
          }

          windowManager.safeSendToOverlay("audio-rms", { rms });
        }

        return;
      }

      // Preserve normal microphone / manual speech-recognition behaviour.
      speechService.handleAudioChunkFromRenderer(pcm);
    });

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("main-window-ready", () => {
      // Re-check availability whenever the main overlay finishes loading;
      // this covers first-run where the window was hidden during onboarding.
      this.speechAvailable = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      const { BrowserWindow } = require("electron");
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("speech-availability", { available: this.speechAvailable });
        }
      });
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        // Enforce horizontal constraints: min ~one icon, max original width
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        try {
          // Match content size to the DOM so no extra transparent area remains
          mainWindow.setContentSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        } catch (e) {
          // Fallback in case setContentSize isn’t available on some platform
          mainWindow.setSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        }
        logger.debug("Main window resized (content)", { width: clampedWidth, height });
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("clear-session-memory", () => {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      return { success: true };
    });

    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      const cleanText = (text || "").trim();
      if (!cleanText) return { success: false, error: "Empty message" };

      // Add chat message to session memory ONCE
      sessionManager.addUserInput(cleanText, 'chat');
      logger.info('[CHAT_LLM] Typed chat message submitted', {
        textLength: cleanText.length,
        activeSkill: this.activeSkill
      });

      (async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processWithLLM(cleanText, sessionHistory, true);
        } catch (error) {
          logger.error("[CHAT_LLM] Failed to process chat message with LLM", {
            error: error.message,
            textPreview: cleanText.substring(0, 50)
          });
        }
      })();

      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    ipcMain.handle("set-gemini-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    ipcMain.handle("get-gemini-status", () => {
      return llmService.getStats();
    });

    // ── AI Provider & Ollama Local Copilot IPC Handlers ──
    ipcMain.handle("get-ai-provider", () => {
      return { provider: this.aiProvider };
    });

    ipcMain.handle("set-ai-provider", (event, provider) => {
      if (provider === "ollama" || provider === "gemini") {
        this.aiProvider = provider;
        logger.info("AI Provider changed", { provider: this.aiProvider });
      }
      return { provider: this.aiProvider };
    });

    ipcMain.handle("check-ollama-status", async () => {
      return await ollamaService.checkStatus();
    });

    ipcMain.handle("test-ollama-model", async () => {
      return await ollamaService.testModel();
    });

    ipcMain.handle("select-call-brief", async () => {
      const result = await dialog.showOpenDialog({
        title: "Select Client Call Brief (.md)",
        filters: [{ name: "Markdown Files", extensions: ["md", "markdown"] }],
        properties: ["openFile"]
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { canceled: true };
      }

      try {
        const status = callBriefManager.loadBriefFromFile(result.filePaths[0]);
        windowManager.broadcastToAllWindows("call-brief-updated", callBriefManager.getBriefStatus());
        return { success: true, status };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("select-call-brief-fixture", (event, fixturePath) => {
      if (process.env.NODE_ENV !== "test" && process.env.OPENCLUELY_E2E_TEST !== "1") {
        return { success: false, error: "Fixture selection is only permitted in E2E test mode." };
      }
      try {
        const fullPath = path.isAbsolute(fixturePath) ? fixturePath : path.join(__dirname, fixturePath);
        const status = callBriefManager.loadBriefFromFile(fullPath);
        windowManager.broadcastToAllWindows("call-brief-updated", callBriefManager.getBriefStatus());
        return { success: true, status };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("get-call-brief-status", () => {
      return callBriefManager.getBriefStatus();
    });

    ipcMain.handle("get-call-brief-preview", () => {
      return callBriefManager.getBriefPreview();
    });

    ipcMain.handle("set-call-brief-options", (event, options) => {
      const status = callBriefManager.setOptions(options);
      windowManager.broadcastToAllWindows("call-brief-updated", status);
      return { success: true, status };
    });

    ipcMain.handle("start-new-call", () => {
      const status = callBriefManager.startNewCall();
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      windowManager.broadcastToAllWindows("call-brief-updated", status);
      return { success: true, status };
    });

    ipcMain.handle("end-call-and-purge", async () => {
      const sckAudioService = require("./src/services/sck-audio.service");
      const blackholeAudioService = require("./src/services/blackhole-audio.service");
      const streamingTranscriptionService = require("./src/services/streaming-transcription.service");
      const questionDetectorService = require("./src/services/question-detector.service");

      if (this.speechService && this.speechService.isRecording) {
        try { await this.speechService.stopRecording(); } catch (_) {}
      }
      try {
        blackholeAudioService.stopCapture();
        sckAudioService.stopCapture();
        streamingTranscriptionService.stopWorker();
        blackholeAudioService.removeAllListeners();
        sckAudioService.removeAllListeners();
        streamingTranscriptionService.removeAllListeners();
        questionDetectorService.removeAllListeners();
        questionDetectorService.reset();
      } catch (_) {}

      this.liveMicCaptureActive = false;

      try {
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("recording-stopped");
          }
        });
      } catch (_) {}

      if (this.processedUtteranceIds) this.processedUtteranceIds.clear();
      this.liveCallActive = false;
      this.liveCallStarting = false;

      const status = await callBriefManager.endCallAndPurge();
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      windowManager.broadcastToAllWindows("call-brief-updated", status);
      this.setCopilotState("IDLE", "Copilot Purged & Idle");
      return { success: true, status };
    });

    // Live Call Copilot & ScreenCaptureKit IPC Handlers
    ipcMain.handle("get-audio-sources", async () => {
      try {
        const sckAudioService = require("./src/services/sck-audio.service");
        return await sckAudioService.getShareableApps();
      } catch (err) {
        return {
          success: false,
          code: "GET_AUDIO_SOURCES_FAILED",
          error: err.message,
          apps: []
        };
      }
    });

    ipcMain.handle("start-live-call", async (event, sourceOptions = {}) => {
      const currentState = this.copilotState || "IDLE";
      if (currentState !== "IDLE" && currentState !== "ERROR") {
        logger.warn(`[CALL] Rejecting start request: session state is ${currentState}`);
        return { success: false, error: `Live Call session is already starting or active (state: ${currentState}).` };
      }

      this.setCopilotState("PREPARING", "Initializing Live Call Copilot...");
      this.liveCallStarting = true;
      this.liveMicCaptureActive = false;

      if (!this.processedUtteranceIds) this.processedUtteranceIds = new Set();
      this.processedUtteranceIds.clear();

      logger.info("[CALL] START Live Call Copilot Mode...", sourceOptions);

      const sckAudioService = require("./src/services/sck-audio.service");
      const streamingTranscriptionService = require("./src/services/streaming-transcription.service");
      const questionDetectorService = require("./src/services/question-detector.service");
      const localRetrievalService = require("./src/services/local-retrieval.service");

      const rollback = async (errCode, errMsg) => {
        logger.error("[CALL] Startup failed, executing FULL ROLLBACK...", { errCode, errMsg });
        this.setCopilotState("STOPPING", `Rolling back session: ${errMsg}`);
        try { sckAudioService.stopCapture(); } catch (_) {}
        try { streamingTranscriptionService.stopWorker(); } catch (_) {}
        try { sckAudioService.removeAllListeners(); } catch (_) {}
        try { streamingTranscriptionService.removeAllListeners(); } catch (_) {}
        try { questionDetectorService.removeAllListeners(); } catch (_) {}
        try { questionDetectorService.reset(); } catch (_) {}
        try { await ollamaService.unloadModel(); } catch (_) {}
        this.liveMicCaptureActive = false;
        try {
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) win.webContents.send("recording-stopped");
          });
        } catch (_) {}

        this.liveCallActive = false;
        this.liveCallStarting = false;
        this.processedUtteranceIds.clear();

        this.setCopilotState("ERROR", `Startup Failed: ${errMsg}`);
        return { success: false, code: errCode, error: errMsg };
      };

      try {
        // 1. Reset question detector state
        questionDetectorService.reset();

        // 2. Prepare selected brief before loading local models.
        callBriefManager.startNewCall();
        const vocabPrompt = callBriefManager.getVocabularyPrompt();

        // IMPORTANT on Apple Silicon / unified memory:
        // Load Whisper onto MPS BEFORE pinning Ollama in memory.
        // Loading Ollama first can cause Metal/unified-memory contention
        // while Whisper executes model.to("mps").
        this.setCopilotState(
          "WAITING_FOR_WHISPER",
          "Starting persistent PyTorch Whisper worker..."
        );

        try {
          await streamingTranscriptionService.startWorker("base.en", vocabPrompt);
        } catch (wErr) {
          return await rollback(
            "WHISPER_STARTUP_FAILED",
            `Failed to start Whisper streaming worker: ${wErr.message}`
          );
        }

        // 3. After Whisper is resident and ready, warm the lightweight
        // local Ollama model and keep it available for Live Call answers.
        this.setCopilotState(
          "WAITING_FOR_OLLAMA",
          "Warming local Ollama model..."
        );

        const warmed = await ollamaService.setKeepAliveMode(-1);

        if (!warmed) {
          return await rollback(
            "OLLAMA_WARMUP_FAILED",
            "Failed to connect or warm local Ollama server at 127.0.0.1:11434."
          );
        }

        // 4. Connect audio pipeline
        this.setCopilotState("WAITING_FOR_AUDIO", "Connecting audio pipeline...");

        const blackholeAudioService = require("./src/services/blackhole-audio.service");

        sckAudioService.removeAllListeners("audio-frame");
        sckAudioService.removeAllListeners("audio-stalled");
        sckAudioService.removeAllListeners("audio-recovered");

        blackholeAudioService.removeAllListeners("audio-frame");
        blackholeAudioService.removeAllListeners("audio-stalled");
        blackholeAudioService.removeAllListeners("audio-recovered");

        const audioFrameHandler = ({ pcm, rms }) => {
          streamingTranscriptionService.feedAudioFrame(pcm);
          windowManager.safeSendToOverlay("audio-rms", { rms });
        };

        const audioStalledHandler = ({ ageMs }) => {
          logger.warn(`[CALL] Audio capture stalled (ageMs=${ageMs})`);
          this.setCopilotState("STALLED", "⚠️ Audio capture stalled (no incoming sound)");
        };

        const audioRecoveredHandler = () => {
          logger.info("[CALL] Audio capture recovered");
          this.setCopilotState("ACTIVE", "Listening to System Audio");
        };

        sckAudioService.on("audio-frame", audioFrameHandler);
        sckAudioService.on("audio-stalled", audioStalledHandler);
        sckAudioService.on("audio-recovered", audioRecoveredHandler);

        blackholeAudioService.on("audio-frame", audioFrameHandler);
        blackholeAudioService.on("audio-stalled", audioStalledHandler);
        blackholeAudioService.on("audio-recovered", audioRecoveredHandler);

        streamingTranscriptionService.removeAllListeners("partial-transcript");
        streamingTranscriptionService.on("partial-transcript", (text) => {
          logger.info("[WHISPER-STREAM] partial=" + text);
          questionDetectorService.handlePartial(text);
          windowManager.safeSendToOverlay("transcript-partial", { text });
          windowManager.safeSendToChat("transcript-partial", { text });
        });

        streamingTranscriptionService.removeAllListeners("final-transcript");
        streamingTranscriptionService.on("final-transcript", (text) => {
          logger.info("[WHISPER-STREAM] final=" + text);
          this.lastFinalTranscript = text;
          questionDetectorService.handleFinal(text);
          windowManager.safeSendToOverlay("transcript-final", { text });
          windowManager.safeSendToChat("transcript-final", { text });
        });

        questionDetectorService.removeAllListeners("question-detected");
        questionDetectorService.on("question-detected", async ({ utteranceId, question }) => {
          if (this.processedUtteranceIds.has(utteranceId)) return;
          this.processedUtteranceIds.add(utteranceId);

          logger.info(`[QUESTION] finalized (${utteranceId}): "${question}"`);

          windowManager.safeSendToOverlay("question-detected", { utteranceId, question });
          windowManager.safeSendToChat("question-detected", { utteranceId, question });

          const retrieval = localRetrievalService.retrieveRelevantSections(question);
          logger.info("[RETRIEVAL]", {
            query: question,
            sectionsCount: retrieval.sections ? retrieval.sections.length : 0,
            latencyMs: retrieval.latencyMs,
            headings: (retrieval.sections || []).map(s => s.title)
          });

          const prompt = callBriefManager.buildSystemInstruction();
          const messages = [
            { role: "system", content: prompt },
            { role: "user", content: `Context Facts:\n${retrieval.formattedContext}\n\nQuestion: ${question}` }
          ];

          let fullResponse = "";
          logger.info("[OLLAMA] request started", { model: ollamaService.activeModel });
          const startTime = Date.now();

          await ollamaService.generateStream(messages, (delta) => {
            fullResponse += delta;
            windowManager.safeSendToOverlay("answer-chunk", { utteranceId, delta });
            windowManager.safeSendToChat("answer-chunk", { utteranceId, delta });
          }, { keepAlive: -1 });

          logger.info("[OLLAMA] response completed", { latencyMs: Date.now() - startTime, length: fullResponse.length });

          const validatedAnswer = callBriefManager.validateGroundedAnswer(fullResponse);

          logger.info("[OVERLAY] answer displayed");
          windowManager.safeSendToOverlay("answer-final", { utteranceId, fullText: validatedAnswer });
          windowManager.safeSendToChat("answer-final", { utteranceId, fullText: validatedAnswer });
        });

        // 5. Start selected audio capture.
        // Built-in microphone is the meeting-default local path.
        this.setCopilotState("WAITING_FOR_PCM", "Waiting for microphone PCM audio...");

        let captureInfo;

        if (sourceOptions && sourceOptions.type === "microphone") {
          this.liveMicPcmFrames = 0;
          this.liveMicPcmBytes = 0;
          this.liveMicLastFrameAt = 0;
          this.liveMicLastRms = 0;
          this.liveMicCaptureActive = true;

          logger.info("[LIVE-MIC] Starting MacBook built-in microphone capture");

          // Existing renderer recording event starts getUserMedia in MainWindowUI.
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("recording-started");
            }
          });

          // Do not claim ACTIVE until real renderer PCM reaches the
          // already-loaded persistent Whisper worker.
          const pcmDeadline = Date.now() + 7000;

          while (this.liveMicPcmFrames < 5 && Date.now() < pcmDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          if (this.liveMicPcmFrames < 5) {
            return await rollback(
              "MIC_PCM_TIMEOUT",
              "MacBook microphone opened but no live PCM audio reached Whisper within 7 seconds."
            );
          }

          captureInfo = {
            success: true,
            source: {
              type: "microphone",
              name: "MacBook Air Microphone"
            }
          };

          logger.info("[LIVE-MIC] PCM handshake verified", {
            frames: this.liveMicPcmFrames,
            bytes: this.liveMicPcmBytes,
            rms: this.liveMicLastRms
          });
        } else {
          // Keep ScreenCaptureKit available only as an optional fallback.
          try {
            captureInfo = await sckAudioService.startCapture(sourceOptions);
          } catch (audioErr) {
            return await rollback(
              audioErr.code || "AUDIO_CAPTURE_FAILED",
              audioErr.message
            );
          }
        }

        this.liveCallActive = true;
        this.liveCallStarting = false;

        this.setCopilotState(
          "ACTIVE",
          "Listening to: " +
            (captureInfo.source
              ? (captureInfo.source.name || captureInfo.source)
              : "MacBook Air Microphone")
        );

        return {
          success: true,
          source: captureInfo.source,
          audioVerified: true
        };
      } catch (err) {
        return await rollback("LIVE_CALL_UNKNOWN_ERROR", err.message);
      }
    });

    ipcMain.handle("answer-last-utterance", async () => {
      const question = this.lastFinalTranscript;
      if (!question || !question.trim()) {
        return { success: false, error: "No recent final transcript available to answer." };
      }

      const utteranceId = "manual_" + Date.now().toString(36);
      logger.info(`[EMERGENCY-FALLBACK] Answering last utterance (${utteranceId}): "${question}"`);

      windowManager.safeSendToOverlay("question-detected", { utteranceId, question });
      windowManager.safeSendToChat("question-detected", { utteranceId, question });

      const localRetrievalService = require("./src/services/local-retrieval.service");
      const retrieval = localRetrievalService.retrieveRelevantSections(question);
      logger.info("[RETRIEVAL-EMERGENCY]", {
        query: question,
        sectionsCount: retrieval.sections ? retrieval.sections.length : 0,
        latencyMs: retrieval.latencyMs
      });

      const prompt = callBriefManager.buildSystemInstruction();
      const messages = [
        { role: "system", content: prompt },
        { role: "user", content: `Context Facts:\n${retrieval.formattedContext}\n\nQuestion: ${question}` }
      ];

      let fullResponse = "";
      await ollamaService.generateStream(messages, (delta) => {
        fullResponse += delta;
        windowManager.safeSendToOverlay("answer-chunk", { utteranceId, delta });
        windowManager.safeSendToChat("answer-chunk", { utteranceId, delta });
      }, { keepAlive: -1 });

      const validatedAnswer = callBriefManager.validateGroundedAnswer(fullResponse);

      windowManager.safeSendToOverlay("answer-final", { utteranceId, fullText: validatedAnswer });
      windowManager.safeSendToChat("answer-final", { utteranceId, fullText: validatedAnswer });

      return { success: true, utteranceId, question, answer: validatedAnswer };
    });

    ipcMain.handle("pause-live-call", () => {
      try {
        const sckAudioService = require("./src/services/sck-audio.service");
        sckAudioService.stopCapture();
        this.liveCallActive = false;
        this.liveCallStarting = false;
        windowManager.broadcastToAllWindows("copilot-status", { active: false, statusText: "Copilot Paused" });
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("create-brief-template", async () => {
      const result = await dialog.showSaveDialog({
        title: "Create Call Brief Template",
        defaultPath: "client-call-brief-template.md",
        filters: [{ name: "Markdown Files", extensions: ["md"] }]
      });

      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }

      try {
        callBriefManager.createCallBriefTemplate(result.filePath);
        return { success: true, filePath: result.filePath };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("process-audio-recording", async (event, arrayBuffer, mimeType) => {
      const reqId = Math.random().toString(36).substring(2, 9);
      logger.info("[MIC-AUDIO] Received full MediaRecorder audio buffer from renderer", {
        reqId,
        byteLength: arrayBuffer ? arrayBuffer.byteLength : 0,
        mimeType
      });

      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        logger.warn("[MIC-AUDIO] Empty audio buffer received", { reqId });
        return { success: false, error: "Empty audio recording buffer" };
      }

      const os = require("os");
      const tempDir = path.join(os.tmpdir(), "opencluely-audio");
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const ext = (mimeType && mimeType.includes("mp4")) ? "mp4" : "webm";
      const rawPath = path.join(tempDir, `mic_${Date.now()}_${reqId}.${ext}`);
      const wavPath = path.join(tempDir, `mic_${Date.now()}_${reqId}_norm.wav`);

      fs.writeFileSync(rawPath, Buffer.from(arrayBuffer));

      try {
        const { execSync } = require("child_process");
        const ffmpegCmd = `ffmpeg -y -i "${rawPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`;
        execSync(ffmpegCmd, { stdio: ["ignore", "pipe", "pipe"] });

        const ffprobeCmd = `ffprobe -v error -show_entries stream=sample_rate,channels,codec_name -of default=noprint_wrappers=1 "${wavPath}"`;
        const probeOutput = execSync(ffprobeCmd, { stdio: ["ignore", "pipe", "pipe"] }).toString();
        logger.info("[MIC-AUDIO] Converted WAV probe result", { reqId, probe: probeOutput.trim().replace(/\n/g, " | ") });

        const text = await speechService.transcribeAudioFile(wavPath);
        logger.info("[MIC-AUDIO] Transcription complete", { reqId, textLength: text ? text.length : 0, textSample: text ? text.substring(0, 50) : "" });

        if (text && text.trim()) {
          const cleanText = text.trim();
          windowManager.broadcastToAllWindows("transcription-received", { text: cleanText });
          this.processWithLLM(cleanText, sessionManager.getHistory(), true);
        } else {
          windowManager.broadcastToAllWindows("speech-status", { status: "No speech detected in recording" });
        }

        return { success: true, text: text ? text.trim() : "" };
      } catch (err) {
        logger.error("[MIC-AUDIO] Audio processing failed", { reqId, error: err.message });
        windowManager.broadcastToAllWindows("speech-status", { status: `Audio error: ${err.message}` });
        return { success: false, error: err.message };
      } finally {
        try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch (_) {}
        try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (_) {}
      }
    });

    // Window binding IPC handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("test-gemini-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("run-gemini-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();
        
        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    // First-run onboarding status — renderer can query to know whether
    // to show the welcome banner / prompt for API-key entry.
    ipcMain.handle("get-first-run-status", () => {
      try {
        return this.firstRunManager.getStatus();
      } catch (e) {
        logger.warn("Failed to get first-run status", { error: e.message });
        return { needsOnboarding: false, error: e.message };
      }
    });

    ipcMain.handle("complete-first-run", async () => {
      try {
        this.firstRunManager.markCompleted();
        this.isFirstRun = false;
        // Reinitialize speech service with the latest persisted settings
        // so the mic button reflects the provider/command set during onboarding.
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable
          ? speechService.isAvailable()
          : false;
        // Show the main overlay window now that onboarding is done
        // and API keys are configured.
        await windowManager.showMainWindow();
        // Broadcast speech availability so the mic button appears
        const { BrowserWindow } = require("electron");
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("speech-availability", { available: this.speechAvailable });
          }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Open a URL in the system browser (used by the GitHub star button
    // in onboarding).
    ipcMain.handle("open-external", async (_event, url) => {
      try {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: "Invalid URL" };
        }
        const { shell } = require("electron");
        await shell.openExternal(url);
        return { ok: true };
      } catch (e) {
        logger.warn("Failed to open external URL", { url, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Close the onboarding wizard window.
    ipcMain.handle("close-onboarding", () => {
      try {
        windowManager.closeOnboarding();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Detect an installed Whisper CLI across common locations.
    ipcMain.handle("detect-whisper", async () => {
      try {
        const installer = this.getWhisperInstaller();
        return await installer.detect();
      } catch (e) {
        logger.warn("Whisper detection failed", { error: e.message });
        return { found: false, command: null, version: null, error: e.message };
      }
    });

    // Install Whisper. Streams progress lines back via `webContents.send`
    // so the renderer can paint them as they arrive.
    ipcMain.handle("install-whisper", async (event) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.install({
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper install failed", { error: e.message });
        return { ok: false, command: null, message: e.message, logs: "" };
      }
    });

    // Download Whisper model. Streams progress lines back via `webContents.send`
    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.downloadModel(modelName || 'turbo', {
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper model download failed", { error: e.message });
        return { ok: false, message: e.message, path: null };
      }
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      return { success: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      const window = windowManager.windows.forEach((win, type) => {
        if (win.webContents === webContents) {
          win.hide();
          return true;
        }
      });
      return { success: true };
    });

    // LLM window specific handlers
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Use the same expansion logic for now, can be enhanced later
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      this.cleanQuit();
    });

    ipcMain.on("quit-app", () => {
      this.cleanQuit();
    });
  }

  triggerEmergencyEscape() {
    logger.info("Emergency safe mode activated");
    const now = Date.now();
    if (this._lastEmergencyTime && (now - this._lastEmergencyTime < 2000)) {
      logger.info("Emergency quit triggered (pressed twice within 2s)");
      this.cleanQuit();
      return;
    }
    this._lastEmergencyTime = now;

    try {
      if (speechService && typeof speechService.stopRecording === "function") {
        speechService.stopRecording();
      }
    } catch (_) {}

    try {
      if (windowManager) {
        windowManager.windows.forEach((win) => {
          if (win && !win.isDestroyed()) {
            try {
              win.setIgnoreMouseEvents(true, { forward: true });
              win.setAlwaysOnTop(false);
              win.hide();
            } catch (_) {}
          }
        });
        windowManager.isVisible = false;
        windowManager.isInteractive = false;
      }
    } catch (_) {}
  }

  cleanQuit() {
    if (this.isQuitting) {
      return;
    }
    this.isQuitting = true;

    logger.info("Clean quit initiated");
    try {
      globalShortcut.unregisterAll();
    } catch (_) {}

    try {
      if (speechService && typeof speechService.stopRecording === "function") {
        speechService.stopRecording();
      }
    } catch (_) {}

    try {
      if (windowManager) {
        windowManager.destroyAllWindows();
      }
    } catch (_) {}

    setTimeout(() => {
      try {
        const { app } = require("electron");
        app.quit();
      } catch (_) {}
      setTimeout(() => process.exit(0), 500);
    }, 100);
  }

  _handleSpeechRequest(event, requestType) {
    const senderWebContents = event ? event.sender : null;
    const browserWindow = senderWebContents ? BrowserWindow.fromWebContents(senderWebContents) : null;
    const browserWindowId = browserWindow ? browserWindow.id : 'main-process-shortcut';
    const webContentsId = senderWebContents ? senderWebContents.id : 'N/A';
    const senderUrl = senderWebContents ? senderWebContents.getURL() : 'globalShortcut (Alt+R)';
    const senderFile = senderUrl.split('/').pop() || senderUrl;
    const timestamp = new Date().toISOString();
    const currentState = speechService.state || (speechService.isRecording ? 'recording' : 'idle');

    logger.info('[SPEECH_DIAGNOSTIC] Speech request received', {
      requestType,
      browserWindowId,
      webContentsId,
      senderFile,
      currentState,
      timestamp
    });

    const now = Date.now();
    const sourceKey = `${browserWindowId}:${webContentsId}:${requestType}`;
    if (!this._lastSpeechRequestTime) this._lastSpeechRequestTime = {};
    const lastTime = this._lastSpeechRequestTime[sourceKey] || 0;
    if (now - lastTime < 600) {
      logger.warn('[SPEECH_DIAGNOSTIC] Suppressing debounced speech request from same source', {
        requestType,
        sourceKey,
        elapsedMs: now - lastTime
      });
      return speechService.getStatus ? speechService.getStatus() : { success: false, reason: 'debounced' };
    }
    this._lastSpeechRequestTime[sourceKey] = now;

    if (requestType === 'start') {
      if (currentState === 'idle') {
        speechService.startRecording();
      } else {
        logger.warn(`[SPEECH_DIAGNOSTIC] Start request ignored, current state: ${currentState}`);
      }
    } else if (requestType === 'stop') {
      if (currentState === 'recording' || currentState === 'starting') {
        speechService.stopRecording();
      } else {
        logger.warn(`[SPEECH_DIAGNOSTIC] Stop request ignored, current state: ${currentState}`);
      }
    } else if (requestType === 'toggle') {
      if (currentState === 'idle') {
        speechService.startRecording();
        windowManager.showChatWindow();
      } else if (currentState === 'recording' || currentState === 'starting') {
        speechService.stopRecording();
        windowManager.hideChatWindow();
      }
    }

    return speechService.getStatus ? speechService.getStatus() : { success: true };
  }

  toggleSpeechRecognition() {
    const isAvailable = typeof speechService.isAvailable === 'function' ? speechService.isAvailable() : !!speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-status", { status: 'Speech recognition unavailable', available: false });
        windowManager.broadcastToAllWindows("speech-availability", { available: false });
      } catch (e) {}
      return;
    }
    return this._handleSpeechRequest(null, 'toggle');
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = [
      "dsa",
    ];

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];
    this.activeSkill = newSkill;

    // Update session manager with the new skill
    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    // Broadcast the skill change to all windows
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    if (this.aiProvider === 'ollama') {
      const msg = "Local Ollama operates in text-only mode for client calls. Vision screenshot analysis requires switching provider to Gemini.";
      windowManager.showLLMResponse(msg, { skill: this.activeSkill, usedFallback: true });
      this.broadcastOCRError(msg);
      return;
    }

    const startTime = Date.now();

    try {
      windowManager.showLLMLoading();

  const capture = await captureService.captureAndProcess();

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        windowManager.hideLLMResponse();
        this.broadcastOCRError("Failed to capture screenshot image");
        return;
      }

      // Use image directly with LLM and active skill; do not send chat messages here
      const sessionHistory = sessionManager.getOptimizedHistory();

      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `img-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });

      const llmResult = await llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });
    } catch (error) {
      logger.error("Screenshot OCR processing failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      windowManager.hideLLMResponse();
      this.broadcastOCRError(error.message);
      
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  async processWithLLM(text, sessionHistory, isAlreadyInSession = false) {
    try {
      if (!isAlreadyInSession) {
        sessionManager.addUserInput(text, 'llm_input');
      }

      const historyCount = (sessionHistory && sessionHistory.recent) ? sessionHistory.recent.length : 0;
      logger.info('[CHAT_LLM] Request started', {
        inputLength: text.length,
        historyCount,
        activeSkill: this.activeSkill,
        provider: this.aiProvider,
        requestId: (this._responseSeq || 0) + 1
      });

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `chat-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      windowManager.showLLMLoading();

      // ── Local Ollama Provider Flow ──
      if (this.aiProvider === 'ollama') {
        const ollamaStatus = await ollamaService.checkStatus();
        if (!ollamaStatus.connected) {
          throw new Error("Ollama is not running. Open Ollama and try again.");
        }
        if (!ollamaStatus.modelReady) {
          throw new Error(`The local Qwen model is not installed (${ollamaStatus.modelName}). Please pull it using: ollama pull ${ollamaStatus.modelName}`);
        }

        const briefContext = callBriefManager.getRelevantContext(text);
        const systemPrompt = callBriefManager.buildSystemInstruction();

        let contextMessage = systemPrompt;
        if (briefContext.formattedContext) {
          contextMessage += `\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${briefContext.formattedContext}`;
        }

        // Small recent history window (last 6 items / 3 turns max)
        const recentHistory = (sessionHistory && sessionHistory.recent) ? sessionHistory.recent.slice(-6) : [];
        const messages = [
          { role: 'system', content: contextMessage }
        ];

        for (const evt of recentHistory) {
          if (evt.role === 'user' || evt.role === 'model') {
            messages.push({
              role: evt.role === 'model' ? 'assistant' : 'user',
              content: (evt.content || '').trim()
            });
          }
        }

        // Add current user prompt
        messages.push({ role: 'user', content: text });

        let numPredict = 400;
        if (callBriefManager.answerLength === 'very-short') numPredict = 250;
        if (callBriefManager.answerLength === 'standard') numPredict = 500;

        const startTime = Date.now();
        const streamedResponse = await ollamaService.generateStream(
          messages,
          (delta) => {
            windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
              messageId,
              delta
            });
          },
          { numPredict }
        );

        const processingTime = Date.now() - startTime;
        const result = {
          response: streamedResponse,
          metadata: {
            skill: this.activeSkill,
            provider: 'ollama',
            model: ollamaStatus.modelName,
            processingTime,
            usedFallback: false,
            messageId
          }
        };

        sessionManager.addModelResponse(streamedResponse, {
          skill: this.activeSkill,
          provider: 'ollama',
          processingTime,
          usedFallback: false
        });

        this.broadcastTranscriptionLLMResponse(result);
        windowManager.showLLMResponse(streamedResponse, {
          skill: this.activeSkill,
          processingTime,
          usedFallback: false
        });

        return;
      }

      // ── Gemini Cloud Provider Flow ──
      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);
      const historyEvents = (sessionHistory && sessionHistory.recent) ? sessionHistory.recent : [];

      const llmResult = await llmService.processTextWithSkillStream(
        text,
        this.activeSkill,
        historyEvents,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };etadata = { ...llmResult.metadata, messageId };

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      windowManager.hideLLMResponse();
      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce. Fragments
   * are shown in the UI immediately so speech feels live, but the LLM is only
   * asked once the speaker has actually paused — this is what stops one spoken
   * line from producing two separate, slow answers.
   */
  handleTranscriptionFragment(text) {
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }

    // Show the live transcript right away in all windows.
    sessionManager.addUserInput(fragment, 'speech');
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("transcription-received", { text: fragment });
    });

    this._utteranceBuffer = this._utteranceBuffer
      ? `${this._utteranceBuffer} ${fragment}`
      : fragment;

    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
    }
    this._utteranceTimer = setTimeout(() => {
      this._utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this._utteranceCoalesceMs);
  }

  /**
   * Send the coalesced utterance to the LLM. If a previous dispatch is still
   * running, leave the buffer intact and let that dispatch's completion pick it
   * up — so we never pile up overlapping requests for the same person talking.
   */
  async dispatchCoalescedUtterance() {
    if (this._utteranceDispatchInFlight) {
      return;
    }
    const combined = this._utteranceBuffer.trim();
    if (!combined) {
      return;
    }
    this._utteranceBuffer = "";
    this._utteranceDispatchInFlight = true;

    try {
      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processTranscriptionWithLLM(combined, sessionHistory);
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        text: combined.substring(0, 100)
      });
    } finally {
      this._utteranceDispatchInFlight = false;
      // Anything that arrived while we were busy gets answered now.
      if (this._utteranceBuffer.trim()) {
        this.dispatchCoalescedUtterance();
      }
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    // Hoisted so the catch block can tie a fallback answer to the same UI
    // bubble the streaming start event created; otherwise a total failure
    // leaves an empty streamed bubble stranded next to the fallback message.
    let messageId = null;
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      // Stream the answer so it renders progressively in the chat + overlay.
      // A unique messageId ties the start/chunk/final events to one bubble so
      // the UI never duplicates or interleaves concurrent responses.
      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `tr-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      // Surface the overlay immediately so streamed tokens are visible there
      // too, instead of the overlay only appearing once the full answer lands.
      windowManager.showLLMLoading();

      const llmResult = await llmService.processTranscriptionWithIntelligentResponseStream(
        cleanText,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      // Send response to chat windows
      this.broadcastTranscriptionLLMResponse(llmResult);

      // Also display in the overlay (LLM response) window so the answer
      // appears in both the chat panel and the floating overlay, mirroring
      // the behaviour of screenshot/image responses.
      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      logger.info("Transcription LLM response completed", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      // Try to provide a fallback response
      try {
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, this.activeSkill);
        // Carry the streaming messageId so the chat/overlay replace the live
        // bubble instead of leaving it stuck and appending a duplicate.
        if (messageId) {
          fallbackResult.metadata = { ...fallbackResult.metadata, messageId };
        }

        sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.broadcastTranscriptionLLMResponse(fallbackResult);
        // Mirror to overlay window for consistency
        windowManager.showLLMResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true
        });
        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });
        
      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window && !window.isDestroyed() && window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getWhisperInstaller() {
    if (!this._whisperInstaller) {
      const WhisperInstaller = require("./src/core/whisper-installer");
      const { app } = require("electron");
      this._whisperInstaller = new WhisperInstaller({
        cwd: process.cwd(),
        dataDir: app.getPath("userData"),
        platform: process.platform,
      });
    }
    return this._whisperInstaller;
  }

  getSettings() {
    // Surface every value the settings UI can edit, reading the live source
    // of truth (process.env) so the UI shows exactly what the running app is
    // using. Empty strings are returned rather than skipped so the UI can
    // distinguish "unset" from "stale value from a previous load".
    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || "dsa",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      windowGap: windowManager.windowGap,

      speechProvider: speechService.provider || "whisper",
      azureKey: process.env.AZURE_SPEECH_KEY || "",
      azureRegion: process.env.AZURE_SPEECH_REGION || "",
      whisperCommand: process.env.WHISPER_COMMAND || "",
      whisperModel: process.env.WHISPER_MODEL || "turbo",
      whisperLanguage: process.env.WHISPER_LANGUAGE || "en",
      whisperSegmentMs: process.env.WHISPER_SEGMENT_MS || "4000",
      geminiKey: process.env.GEMINI_API_KEY || "",

      azureConfigured: !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION,
      speechAvailable: this.speechAvailable
    };
  }

  saveSettings(settings) {
    try {
      // ── In-memory updates + window broadcasts ──
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        this.updateAppIcon(settings.selectedIcon);
      }
      if (settings.windowGap !== undefined) {
        const gap = Number(settings.windowGap);
        if (Number.isFinite(gap)) windowManager.setWindowGap(gap);
      }

      // ── Persist provider / API-key fields back to .env ──
      // The settings UI is now the source of truth for these values.
      // Writing to .env ensures they survive app restarts and are picked
      // up the next time the app boots.
      const envUpdates = {};
      if (settings.speechProvider === "azure" || settings.speechProvider === "whisper") {
        envUpdates.SPEECH_PROVIDER = settings.speechProvider;
      }
      if (settings.azureKey !== undefined) {
        envUpdates.AZURE_SPEECH_KEY = settings.azureKey;
      }
      if (settings.azureRegion !== undefined) {
        envUpdates.AZURE_SPEECH_REGION = settings.azureRegion;
      }
      if (settings.whisperCommand !== undefined) {
        envUpdates.WHISPER_COMMAND = settings.whisperCommand;
      }
      if (settings.whisperModel !== undefined) {
        envUpdates.WHISPER_MODEL = settings.whisperModel;
      }
      if (settings.whisperLanguage !== undefined) {
        envUpdates.WHISPER_LANGUAGE = settings.whisperLanguage;
      }
      if (settings.whisperSegmentMs !== undefined) {
        envUpdates.WHISPER_SEGMENT_MS = String(settings.whisperSegmentMs);
      }
      if (settings.geminiKey !== undefined) {
        envUpdates.GEMINI_API_KEY = settings.geminiKey;
      }

      // Capture the previous whisper command BEFORE persisting — persistEnvUpdates
      // mutates process.env in place, so comparing afterwards would always read
      // equal and skip the speech re-init below (the exact stale-mic-after-install
      // bug the re-init guards against).
      const prevWhisperCommand = process.env.WHISPER_COMMAND || '';

      const persistedKeys = this.persistEnvUpdates(envUpdates);

      // If the Gemini key was just saved, reinitialize the LLM service
      // so the new client picks up the key. Without this, the test-
      // connection button in the onboarding wizard fails with
      // "Service not initialized" because the client was first created
      // at app startup, before any key was set.
      if (settings.geminiKey !== undefined && envUpdates.GEMINI_API_KEY !== undefined) {
        try {
          llmService.initializeClient();
          logger.info("LLM service reinitialized after Gemini key update");
        } catch (e) {
          logger.warn("Failed to reinitialize LLM service after Gemini key update", {
            error: e.message
          });
        }
      }

      // Reinitialize speech service when provider OR whisper command
      // changes. Without the second check, the install flow (which
      // writes a new whisperCommand after install but keeps the same
      // provider) would leave the speech service pointing at a stale
      // (or non-existent) binary, and the main overlay's mic button
      // would stay hidden / non-functional.
      const providerChanged = settings.speechProvider && speechService.provider !== settings.speechProvider;
      const whisperCommandChanged = settings.whisperCommand !== undefined &&
        prevWhisperCommand !== String(settings.whisperCommand || '');
      if (providerChanged || whisperCommandChanged) {
        try {
          speechService.initializeClient();
          this.speechAvailable = speechService.isAvailable
            ? speechService.isAvailable()
            : false;
          // Broadcast so any open window (settings, overlay, chat)
          // can react immediately — especially the main overlay's
          // mic button, which queries availability on load.
          const { BrowserWindow } = require("electron");
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("speech-availability", { available: this.speechAvailable });
            }
          });
          logger.info('Speech service reinitialized after settings change', {
            providerChanged,
            whisperCommandChanged,
            speechAvailable: this.speechAvailable,
          });
        } catch (e) {
          logger.warn("Failed to reinitialize speech service after settings change", {
            error: e.message
          });
        }
      }

      logger.info("Settings saved successfully", {
        ...settings,
        persistedEnvKeys: persistedKeys
      });
      return { success: true, persistedEnvKeys: persistedKeys };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  persistSettings(settings) {
    // You can extend this to save to a file or database
    // For now, we'll just keep them in memory
    logger.debug("Settings persisted", settings);
  }

  /**
   * Write key=value pairs to the project's .env file. Existing keys are
   * replaced in-place; new keys are appended. Comments and unrelated lines
   * are preserved. Uses an atomic write (temp file + rename) so a crash
   * mid-write cannot corrupt .env.
   *
   * @param {Object<string, string>} updates - keys to upsert
   * @returns {string[]} keys that were actually persisted
   */
  persistEnvUpdates(updates) {
    if (!updates || typeof updates !== "object") return [];
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    const fs = require("fs");
    // Single source of truth — the same file dotenv loaded at startup and that
    // FirstRunManager reads/writes (userData in packaged builds, project .env
    // in dev). Writing to process.cwd() here would silently diverge.
    const envPath = ENV_PATH;

    let existing = "";
    try {
      existing = fs.readFileSync(envPath, "utf8");
    } catch (_) {
      // .env doesn't exist yet — we'll create one from scratch
      existing = "";
    }

    const existingLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    const updated = new Set();
    const outLines = [];

    for (const line of existingLines) {
      // Match "KEY=" (with optional whitespace) but skip comment lines
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
        const key = m[1];
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      } else {
        outLines.push(line);
      }
    }

    // Append any keys that weren't already present
    for (const key of keys) {
      if (!updated.has(key)) {
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      }
    }

    // Update process.env so the running app picks up the new values
    // immediately (and so the settings UI reads the same source of truth).
    for (const key of keys) {
      process.env[key] = String(updates[key]);
    }

    const newContent = outLines.join("\n");
    try {
      const tmpPath = envPath + ".tmp";
      fs.writeFileSync(tmpPath, newContent, "utf8");
      fs.renameSync(tmpPath, envPath);
    } catch (e) {
      logger.error("Failed to persist .env updates", {
        error: e.message,
        keys
      });
      return [];
    }

    logger.info("Persisted .env updates", { keys: Array.from(updated) });
    return Array.from(updated);
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon (only if dock is available)
        if (app.dock) {
          app.dock.setIcon(fullIconPath);

          // Force dock refresh with multiple attempts
          const retryDockIcon = () => {
            try { app.dock.setIcon(fullIconPath); } catch (_) { /* dock may not exist */ }
          };
          setTimeout(retryDockIcon, 100);
          setTimeout(retryDockIcon, 500);
        }
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(__dirname, `assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping (Windows only)
      if (process.platform === "win32") {
        app.setAppUserModelId(`${appName.trim()}-${iconKey}`);
      }

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const isTestMode = process.env.NODE_ENV === "test" || process.env.OPENCLUELY_E2E_TEST === "1";
const gotSingleInstanceLock = isTestMode ? true : app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
