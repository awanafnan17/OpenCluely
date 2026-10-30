try {
    // Check if we're in Node.js context or browser context
    let logger;
    try {
        logger = require('../core/logger').createServiceLogger('CHAT-UI');
    } catch (error) {
        logger = {
            info: (...args) => console.log('[CHAT-UI INFO]', ...args),
            debug: (...args) => console.log('[CHAT-UI DEBUG]', ...args),
            error: (...args) => console.error('[CHAT-UI ERROR]', ...args),
            warn: (...args) => console.warn('[CHAT-UI WARN]', ...args)
        };
    }

class ChatWindowUI {
    constructor() {
        this.isRecording = false;
        this.isInteractive = true; // Start in interactive mode
        this.elements = {};
        
        this.init();
    }

    init() {
        try {
            this.setupElements();
            this.setupEventListeners();
            this.addMessage('Chat window initialized. Select a brief and call audio source, then click Start Live Call.', 'system');
            
            logger.info('Chat window UI initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize chat window UI', { error: error.message });
            console.error('Chat window initialization failed:', error);
        }
    }

    setupElements() {
        this.elements = {
            chatMessages: document.getElementById('chatMessages'),
            recordingIndicator: document.getElementById('recordingIndicator'),
            messageInput: document.getElementById('messageInput'),
            sendButton: document.getElementById('sendButton'),
            micButton: document.getElementById('micButton'),
            chatContainer: document.getElementById('chatContainer'),
            interactionIndicator: document.getElementById('interactionIndicator'),
            interactionText: document.getElementById('interactionText'),
            listeningContainer: document.getElementById('listeningContainer'),
            listeningDuration: document.getElementById('listeningDuration'),
            // Copilot Elements
            audioSourceSelect: document.getElementById('audioSourceSelect'),
            refreshAudioSourcesBtn: document.getElementById('refreshAudioSourcesBtn'),
            providerSelect: document.getElementById('providerSelect'),
            ollamaStatusBadge: document.getElementById('ollamaStatusBadge'),
            testOllamaBtn: document.getElementById('testOllamaBtn'),
            briefFilename: document.getElementById('briefFilename'),
            selectBriefBtn: document.getElementById('selectBriefBtn'),
            previewBriefBtn: document.getElementById('previewBriefBtn'),
            startCallBtn: document.getElementById('startCallBtn'),
            endCallBtn: document.getElementById('endCallBtn'),
            createTemplateBtn: document.getElementById('createTemplateBtn'),
            answerLengthSelect: document.getElementById('answerLengthSelect'),
            answerStyleSelect: document.getElementById('answerStyleSelect'),
            briefPreviewModal: document.getElementById('briefPreviewModal'),
            modalBriefTitle: document.getElementById('modalBriefTitle'),
            modalBriefBody: document.getElementById('modalBriefBody'),
            closeModalBtn: document.getElementById('closeModalBtn')
        };
        
        // Validate required elements
        const requiredElements = ['chatMessages', 'micButton', 'sendButton', 'messageInput'];
        for (const elementKey of requiredElements) {
            if (!this.elements[elementKey]) {
                throw new Error(`Required element '${elementKey}' not found`);
            }
        }
        
        // Initialize listening timer
        this.listeningStartTime = null;
        this.listeningTimer = null;
    }

    setupEventListeners() {
        // Interaction state handlers
        if (window.electronAPI) {
            window.electronAPI.onInteractionModeChanged((event, interactive) => {
                this.isInteractive = interactive;
                if (interactive) {
                    this.handleInteractionEnabled();
                } else {
                    this.handleInteractionDisabled();
                }
            });
            
            // Speech recognition handlers
            window.electronAPI.onTranscriptionReceived((event, data) => {
                if (data && data.text) {
                    this.handleTranscription(data.text);
                } else {
                    console.warn('Transcription event received but no text data:', data);
                }
            });
            
            // Listen for interim transcription (real-time)
            if (window.electronAPI.onInterimTranscription) {
                window.electronAPI.onInterimTranscription((event, data) => {
                    if (data && data.text) {
                        this.showInterimText(data.text);
                    }
                });
            }
            
            window.electronAPI.onSpeechStatus((event, data) => {
                if (data && data.status) {
                    this.addMessage(data.status, 'system');
                }
            });

            if (window.electronAPI.onRecordingStarted) {
                window.electronAPI.onRecordingStarted(() => {
                    this.handleRecordingStarted();
                });
            }

            if (window.electronAPI.onRecordingStopped) {
                window.electronAPI.onRecordingStopped(() => {
                    this.handleRecordingStopped();
                });
            }
            
            window.electronAPI.onSpeechError((event, data) => {
                if (data && data.error) {
                    this.addMessage(`Speech Error: ${data.error}`, 'error');
                    this.handleRecordingStopped(); // Stop recording on error
                }
            });
            
            // Skill handlers
            window.electronAPI.onSkillChanged((event, data) => {
                if (data && data.skill) {
                    this.handleSkillActivated(data.skill);
                }
            });
            
            // Session handlers
            window.electronAPI.onSessionCleared(() => {
                this.addMessage('Session memory has been cleared', 'system');
            });
            
            window.electronAPI.onOcrCompleted((event, data) => {
                if (data.text && data.text.trim()) {
                    this.addMessage(`📷 OCR Result: ${data.text}`, 'transcription');
                }
            });
            
            window.electronAPI.onOcrError((event, data) => {
                this.addMessage(`OCR Error: ${data.error}`, 'error');
            });
            
            window.electronAPI.onLlmResponse((event, data) => {
                // Store AI response (text + snippets) in chat history
                if (data && data.response) {
                    this.hideThinkingIndicator?.();
                    this.renderAssistantResponse(data.response);
                }
            });
            
            window.electronAPI.onLlmError((event, data) => {
                this.addMessage(`LLM Error: ${data.error}`, 'error');
            });
            
            window.electronAPI.onTranscriptionLlmResponse((event, data) => {
                if (data && data.response) {
                    // Hide thinking indicator
                    this.hideThinkingIndicator();
                    // Finalize the streaming bubble (if any) with fully formatted
                    // markdown + code snippets; otherwise render fresh.
                    this.finalizeStreamingResponse(data.messageId, data.response);
                }
            });

            // Streaming response lifecycle: a bubble is created on start, grows
            // as chunks arrive, then is replaced with the formatted final render.
            if (window.electronAPI.onTranscriptionLlmResponseStart) {
                window.electronAPI.onTranscriptionLlmResponseStart((event, data) => {
                    if (data && data.messageId) {
                        this.beginStreamingResponse(data.messageId);
                    }
                });
            }
            if (window.electronAPI.onTranscriptionLlmResponseChunk) {
                window.electronAPI.onTranscriptionLlmResponseChunk((event, data) => {
                    if (data && data.messageId) {
                        this.appendStreamingChunk(data.messageId, data.delta || '');
                    }
                });
            }
        }
        
        // UI event handlers
        this.setupUIHandlers();
        
        logger.debug('Chat window event listeners set up');
    }

    setupUIHandlers() {
        // Microphone button
        this.elements.micButton.addEventListener('click', async () => {
            if (!this.isInteractive) {
                this.addMessage('Window is in non-interactive mode. Press Alt+A to enable interaction.', 'error');
                return;
            }
            
            try {
                if (this.isRecording) {
                    await window.electronAPI.stopSpeechRecognition();
                } else {
                    await window.electronAPI.startSpeechRecognition();
                }
            } catch (error) {
                this.addMessage(`Speech recognition error: ${error.message}`, 'error');
                logger.error('Speech recognition failed', { error: error.message });
            }
        });
        
        // Send button
        this.elements.sendButton.addEventListener('click', () => {
            this.sendMessage();
        });
        
        // Message input
        this.elements.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendMessage();
            }
        });

        // Provider Select
        if (this.elements.providerSelect) {
            this.elements.providerSelect.addEventListener('change', async (e) => {
                const newProvider = e.target.value;
                if (window.electronAPI && window.electronAPI.setAIProvider) {
                    const res = await window.electronAPI.setAIProvider(newProvider);
                    if (res && res.success) {
                        this.addMessage(`AI Provider switched to: ${newProvider === 'ollama' ? 'Local Ollama' : 'Gemini Cloud'}`, 'system');
                    }
                }
            });
        }

        // Emergency Fallback: Option + A (or Alt + A) to "Answer Last Utterance"
        window.addEventListener('keydown', async (e) => {
            if (e.altKey && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                if (window.electronAPI && window.electronAPI.answerLastUtterance) {
                    this.addMessage('⚡ Triggering emergency fallback: Answering last utterance...', 'system');
                    const res = await window.electronAPI.answerLastUtterance();
                    if (!res || !res.success) {
                        this.addMessage(`Emergency Answer Error: ${res ? res.error : 'No response'}`, 'error');
                    }
                }
            }
        });
        if (this.elements.refreshAudioSourcesBtn) {
            this.elements.refreshAudioSourcesBtn.addEventListener('click', () => {
                this.refreshAudioSources();
            });
        }
        this.refreshAudioSources();

        // Select Client Brief
        if (this.elements.selectBriefBtn) {
            this.elements.selectBriefBtn.addEventListener('click', async () => {
                if (window.electronAPI && window.electronAPI.selectCallBrief) {
                    const res = await window.electronAPI.selectCallBrief();
                    if (res && res.success) {
                        const count = (res.status && res.status.headingsCount !== undefined) ? res.status.headingsCount : ((res.status && res.status.parsedCount !== undefined) ? res.status.parsedCount : 0);
                        this.addMessage(`📄 Selected Brief: ${res.status.filename} (${count} headings parsed)`, 'system');
                    } else if (res && !res.canceled && res.error) {
                        this.addMessage(`Brief Error: ${res.error}`, 'error');
                    }
                }
            });
        }

        // Preview Brief
        if (this.elements.previewBriefBtn) {
            this.elements.previewBriefBtn.addEventListener('click', async () => {
                if (window.electronAPI && window.electronAPI.getCallBriefPreview) {
                    const res = await window.electronAPI.getCallBriefPreview();
                    if (res && res.success && res.content) {
                        if (this.elements.modalBriefTitle) this.elements.modalBriefTitle.textContent = `Brief Preview: ${res.filename}`;
                        if (this.elements.modalBriefBody) this.elements.modalBriefBody.textContent = res.content;
                        if (this.elements.briefPreviewModal) this.elements.briefPreviewModal.style.display = 'flex';
                    } else {
                        this.addMessage(res.error || 'No brief loaded to preview.', 'system');
                    }
                }
            });
        }

        // Close Modal
        if (this.elements.closeModalBtn) {
            this.elements.closeModalBtn.addEventListener('click', () => {
                if (this.elements.briefPreviewModal) this.elements.briefPreviewModal.style.display = 'none';
            });
        }

        // Start Live Call
        if (this.elements.startCallBtn) {
            this.elements.startCallBtn.addEventListener('click', async () => {
                if (window.electronAPI && window.electronAPI.startLiveCall) {
                    const audioSourceSelect = document.getElementById('audioSourceSelect');
                    const selectedValue = audioSourceSelect ? audioSourceSelect.value : 'microphone';
                    const selectedText =
                        audioSourceSelect && audioSourceSelect.selectedIndex >= 0
                            ? audioSourceSelect.options[audioSourceSelect.selectedIndex].text
                            : 'Default microphone';

                    const isMicrophone = selectedValue === 'microphone';

                    this.addMessage(
                        isMicrophone
                            ? '🟢 Preloading models & starting microphone capture...'
                            : '🟢 Preloading models & starting system audio capture...',
                        'system'
                    );

                    const res = await window.electronAPI.startLiveCall({
                        type: isMicrophone ? 'microphone' : selectedValue === 'blackhole' ? 'blackhole' : 'system',
                        pid: /^\d+$/.test(selectedValue)
                            ? Number(selectedValue)
                            : null,
                        name: selectedText
                    });
                    if (res && res.success) {
                        this.addMessage(`🔴 Live Call Copilot Active! Listening to: ${res.source ? res.source.name : selectedText}`, 'system');
                    } else {
                        this.addMessage(`Live Call Startup Failed: ${res ? res.error : 'Unknown error'}`, 'error');
                    }
                }
            });
        }

        // End Call & Purge
        if (this.elements.endCallBtn) {
            this.elements.endCallBtn.addEventListener('click', async () => {
                if (window.electronAPI && window.electronAPI.endCallAndPurge) {
                    const res = await window.electronAPI.endCallAndPurge();
                    if (res && res.success) {
                        this.clearChatHistory(true);
                        if (this.elements.briefFilename) {
                            this.elements.briefFilename.textContent = 'No Client Brief Selected';
                        }
                        this.addMessage('🛑 Call Ended & Memory Purged! Model unloaded from RAM.', 'system');
                    }
                }
            });
        }

        // Create Brief Template
        if (this.elements.createTemplateBtn) {
            this.elements.createTemplateBtn.addEventListener('click', async () => {
                if (window.electronAPI && window.electronAPI.createBriefTemplate) {
                    const res = await window.electronAPI.createBriefTemplate();
                    if (res && res.success) {
                        this.addMessage(`📝 Blank template created at: ${res.filePath}`, 'system');
                    } else {
                        this.addMessage(`Template Error: ${res.error}`, 'error');
                    }
                }
            });
        }

        // Answer Options
        const updateOptions = async () => {
            const answerLength = this.elements.answerLengthSelect ? this.elements.answerLengthSelect.value : 'short';
            const answerStyle = this.elements.answerStyleSelect ? this.elements.answerStyleSelect.value : 'markdown-instructions';
            if (window.electronAPI && window.electronAPI.setCallBriefOptions) {
                await window.electronAPI.setCallBriefOptions({ answerLength, answerStyle });
            }
        };

        if (this.elements.answerLengthSelect) {
            this.elements.answerLengthSelect.addEventListener('change', updateOptions);
        }
        if (this.elements.answerStyleSelect) {
            this.elements.answerStyleSelect.addEventListener('change', updateOptions);
        }

        // Live Call Stream Listeners
        if (window.electronAPI) {
            if (window.electronAPI.onTranscriptPartial) {
                window.electronAPI.onTranscriptPartial((event, data) => {
                    this.updateLiveTranscript(data ? data.text : '', false);
                });
            }
            if (window.electronAPI.onTranscriptFinal) {
                window.electronAPI.onTranscriptFinal((event, data) => {
                    this.updateLiveTranscript(data ? data.text : '', true);
                });
            }
            if (window.electronAPI.onQuestionDetected) {
                window.electronAPI.onQuestionDetected((event, data) => {
                    if (data && data.question) {
                        this.addQuestionAndAnswerCards(data.utteranceId, data.question);
                    }
                });
            }
            if (window.electronAPI.onAnswerChunk) {
                window.electronAPI.onAnswerChunk((event, data) => {
                    if (data && data.delta) {
                        this.updateStreamingAnswer(data.utteranceId, data.delta);
                    }
                });
            }
            if (window.electronAPI.onAnswerFinal) {
                window.electronAPI.onAnswerFinal((event, data) => {
                    if (data && data.fullText) {
                        this.finalizeStreamingAnswer(data.utteranceId, data.fullText);
                    }
                });
            }
        }

        // Initial sync of statuses
        this.syncCopilotStatus();
    }

    async syncCopilotStatus() {
        try {
            if (window.electronAPI) {
                if (window.electronAPI.getAIProvider && this.elements.providerSelect) {
                    const res = await window.electronAPI.getAIProvider();
                    const provider = (res && typeof res === 'object' && res.provider) ? res.provider : (typeof res === 'string' ? res : 'ollama');
                    this.elements.providerSelect.value = provider;
                }
                if (window.electronAPI.checkOllamaStatus && this.elements.ollamaStatusBadge) {
                    const status = await window.electronAPI.checkOllamaStatus();
                    if (status.connected && status.modelReady) {
                        this.elements.ollamaStatusBadge.textContent = `🟢 Ready (${status.modelName})`;
                        this.elements.ollamaStatusBadge.className = 'status-badge connected';
                    } else if (status.connected) {
                        this.elements.ollamaStatusBadge.textContent = `🟡 Model missing (${status.modelName})`;
                        this.elements.ollamaStatusBadge.className = 'status-badge disconnected';
                    } else {
                        this.elements.ollamaStatusBadge.textContent = `🔴 Offline`;
                        this.elements.ollamaStatusBadge.className = 'status-badge disconnected';
                    }
                }
                if (window.electronAPI.getCallBriefStatus && this.elements.briefFilename) {
                    const briefStatus = await window.electronAPI.getCallBriefStatus();
                    if (briefStatus && briefStatus.hasBrief) {
                        this.elements.briefFilename.textContent = briefStatus.filename;
                    } else {
                        this.elements.briefFilename.textContent = 'No Client Brief Selected';
                    }
                }
                if (window.electronAPI.onCallBriefUpdated && !this._briefListenerRegistered) {
                    this._briefListenerRegistered = true;
                    window.electronAPI.onCallBriefUpdated((event, status) => {
                        if (this.elements.briefFilename) {
                            this.elements.briefFilename.textContent = (status && status.hasBrief) ? status.filename : 'No Client Brief Selected';
                        }
                    });
                }
            }
        } catch (err) {
            logger.warn('Failed to sync copilot status', { error: err.message });
        }
    }

    async refreshAudioSources() {
        const select = document.getElementById('audioSourceSelect');
        if (!select) return;

        select.disabled = true;
        select.innerHTML = '';
        const loadingOpt = document.createElement('option');
        loadingOpt.value = 'system';
        loadingOpt.textContent = 'Loading audio sources...';
        select.appendChild(loadingOpt);

        if (!window.electronAPI || !window.electronAPI.getAudioSources) {
            select.disabled = false;
            select.innerHTML = '';
            const errOpt = document.createElement('option');
            errOpt.value = 'system';
            errOpt.textContent = 'Reliable System Audio (Recommended)';
            select.appendChild(errOpt);
            return;
        }

        try {
            const res = await window.electronAPI.getAudioSources();
            select.disabled = false;
            select.innerHTML = '';

            const micOpt = document.createElement('option');
            micOpt.value = 'microphone';
            micOpt.textContent = 'Default microphone';
            select.appendChild(micOpt);

            const systemOpt = document.createElement('option');
            systemOpt.value = res && res.platform === 'win32' ? 'windows-loopback' : 'blackhole';
            systemOpt.textContent = res && res.platform === 'win32'
                ? 'System audio (WASAPI loopback)'
                : 'System audio (BlackHole 2ch)';
            select.appendChild(systemOpt);
            systemOpt.selected = true;

            if (res && res.platform !== 'win32') {
                const sckOpt = document.createElement('option');
                sckOpt.value = 'system';
                sckOpt.textContent = 'System audio (ScreenCaptureKit experimental)';
                select.appendChild(sckOpt);
            }

            if (res && res.success && res.platform !== 'win32' && Array.isArray(res.apps)) {
                const seenPids = new Set();
                res.apps.forEach(app => {
                    if (app && app.pid && !seenPids.has(app.pid)) {
                        seenPids.add(app.pid);
                        const opt = document.createElement('option');
                        opt.value = String(app.pid);
                        opt.textContent = `${app.name} (PID ${app.pid})`;
                        select.appendChild(opt);
                    }
                });
            } else if (res && res.code === 'SCREEN_CAPTURE_PERMISSION_DENIED') {
                const permOpt = document.createElement('option');
                permOpt.value = 'system';
                permOpt.textContent = '⚠️ Screen Recording Permission Required in macOS Settings';
                select.appendChild(permOpt);
                this.addMessage('⚠️ Screen & System Audio Recording permission is required. Enable OpenCluely in System Settings → Privacy & Security → Screen & System Audio Recording, then restart OpenCluely.', 'error');
            }
        } catch (err) {
            select.disabled = false;
            select.innerHTML = '';
            const defaultOpt = document.createElement('option');
            defaultOpt.value = 'system';
            defaultOpt.textContent = 'Reliable System Audio (Recommended)';
            select.appendChild(defaultOpt);
        }
    }

    updateLiveTranscript(text, isFinal) {
        if (!text || !text.trim()) return;
        let liveBubble = document.getElementById('liveTranscriptBubble');
        if (!liveBubble) {
            liveBubble = document.createElement('div');
            liveBubble.id = 'liveTranscriptBubble';
            liveBubble.className = 'chat-message system live-transcript';
            liveBubble.style.fontStyle = 'italic';
            liveBubble.style.opacity = '0.85';
            this.elements.chatMessages.appendChild(liveBubble);
        }
        liveBubble.textContent = `🎙️ Listening: "${text}"`;
        if (isFinal) {
            liveBubble.style.fontWeight = 'bold';
            setTimeout(() => {
                if (liveBubble && liveBubble.parentNode) {
                    liveBubble.parentNode.removeChild(liveBubble);
                }
            }, 3000);
        }
        this.scrollToBottom();
    }

    addQuestionAndAnswerCards(uttId, questionText) {
        if (!this.elements.chatMessages) return;

        const id = uttId || `utt_${Date.now()}`;

        // Create Question Card
        const qCard = document.createElement('div');
        qCard.className = 'live-call-question-card';
        qCard.id = `q_${id}`;
        qCard.innerHTML = `<span class="question-badge">QUESTION</span><span class="question-text">${questionText}</span>`;
        this.elements.chatMessages.appendChild(qCard);

        // Create Solid Answer Card
        const aCard = document.createElement('div');
        aCard.className = 'live-call-answer-card streaming';
        aCard.id = `ans_${id}`;
        aCard.innerHTML = `<div class="answer-badge">ANSWER</div><div class="answer-body"></div>`;
        this.elements.chatMessages.appendChild(aCard);

        this.scrollToBottomGentle();
    }

    updateStreamingAnswer(uttId, delta) {
        const id = uttId || `utt_${Date.now()}`;
        let ansCard = document.getElementById(`ans_${id}`);
        if (!ansCard) {
            this.addQuestionAndAnswerCards(id, 'Question Detected');
            ansCard = document.getElementById(`ans_${id}`);
        }
        const body = ansCard ? ansCard.querySelector('.answer-body') : null;
        if (body) {
            body.textContent = (body.textContent || '') + delta;
        }
        this.scrollToBottomGentle();
    }

    finalizeStreamingAnswer(uttId, fullText) {
        const id = uttId || `utt_${Date.now()}`;
        let ansCard = document.getElementById(`ans_${id}`);
        if (!ansCard) {
            this.addQuestionAndAnswerCards(id, 'Question');
            ansCard = document.getElementById(`ans_${id}`);
        }
        if (ansCard) {
            ansCard.classList.remove('streaming');
            const body = ansCard.querySelector('.answer-body');
            if (body) {
                body.innerHTML = this.formatLiveCallAnswer(fullText);
            }
        }
        this.scrollToBottomGentle();
    }

    scrollToBottomGentle() {
        if (!this.elements.chatMessages) return;
        const container = this.elements.chatMessages;
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distanceFromBottom < 150) {
            container.scrollTop = container.scrollHeight;
        }
    }

    formatLiveCallAnswer(fullText) {
        if (!fullText || !fullText.trim()) return '';
        let text = fullText.trim();
        text = text.replace(/^#+\s*/gm, '');

        const lines = text.split('\n');
        let html = '';
        let inList = false;
        let listType = 'ul';
        let firstSentenceExtracted = false;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (!line) {
                if (inList) {
                    html += `</${listType}>`;
                    inList = false;
                }
                continue;
            }

            const bulletMatch = line.match(/^[-*•]\s+(.+)/);
            if (bulletMatch) {
                if (!inList || listType !== 'ul') {
                    if (inList) html += `</${listType}>`;
                    html += '<ul style="margin: 8px 0 12px 0; padding-left: 22px;">';
                    inList = true;
                    listType = 'ul';
                }
                let itemText = bulletMatch[1].replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                html += `<li style="margin-bottom: 6px; font-size: 18px; line-height: 1.55; color: #F9FAFB;">${itemText}</li>`;
                continue;
            }

            const numMatch = line.match(/^\d+\.\s+(.+)/);
            if (numMatch) {
                if (!inList || listType !== 'ol') {
                    if (inList) html += `</${listType}>`;
                    html += '<ol style="margin: 8px 0 12px 0; padding-left: 22px;">';
                    inList = true;
                    listType = 'ol';
                }
                let itemText = numMatch[1].replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                html += `<li style="margin-bottom: 6px; font-size: 18px; line-height: 1.55; color: #F9FAFB;">${itemText}</li>`;
                continue;
            }

            if (inList) {
                html += `</${listType}>`;
                inList = false;
            }

            line = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

            if (!firstSentenceExtracted) {
                firstSentenceExtracted = true;
                const sentenceEnd = line.search(/[.!?](?:\s|$)/);
                if (sentenceEnd !== -1 && sentenceEnd < line.length - 1) {
                    const firstSent = line.slice(0, sentenceEnd + 1);
                    const rest = line.slice(sentenceEnd + 1).trim();
                    html += `<div class="opening-sentence">${firstSent}</div>`;
                    if (rest) {
                        html += `<p style="margin: 0 0 10px 0; font-size: 18px; line-height: 1.6; color: #F3F4F6;">${rest}</p>`;
                    }
                } else {
                    html += `<div class="opening-sentence">${line}</div>`;
                }
            } else {
                html += `<p style="margin: 0 0 10px 0; font-size: 18px; line-height: 1.6; color: #F3F4F6;">${line}</p>`;
            }
        }

        if (inList) {
            html += `</${listType}>`;
        }

        return html;
    }

    handleInteractionEnabled() {
        this.isInteractive = true;
        this.elements.chatContainer.classList.remove('non-interactive');
        this.showInteractionIndicator('Interactive', true);
        logger.debug('Interaction mode enabled in chat');
    }

    handleInteractionDisabled() {
        this.isInteractive = false;
        this.elements.chatContainer.classList.add('non-interactive');
        this.showInteractionIndicator('Non-Interactive', false);
        logger.debug('Interaction mode disabled in chat');
    }

    handleRecordingStarted() {
        this.isRecording = true;
        if (this.elements.recordingIndicator) {
            this.elements.recordingIndicator.style.display = 'block';
        }
        if (this.elements.micButton) {
            this.elements.micButton.classList.add('recording');
        }
        
        // Show listening animation
        this.showListeningAnimation();
        
        logger.debug('Recording started in chat window');
    }

    handleRecordingStopped() {
        this.isRecording = false;
        if (this.elements.recordingIndicator) {
            this.elements.recordingIndicator.style.display = 'none';
        }
        if (this.elements.micButton) {
            this.elements.micButton.classList.remove('recording');
        }
        
        // Hide listening animation
        this.hideListeningAnimation();
        
        logger.debug('Recording stopped in chat window');
    }

    handleTranscription(text) {
        if (text && text.trim()) {
            // Hide listening animation first
            this.hideListeningAnimation();
            
            // Show transcribed text with a slight delay for smooth transition
            setTimeout(() => {
                this.addMessage(text, 'transcription');
                
                // Show thinking indicator after transcription
                setTimeout(() => {
                    this.showThinkingIndicator();
                }, 300);
            }, 200);
            
            logger.debug('Transcription received in chat', { textLength: text.length });
        } else {
            console.warn('❌ Transcription text is empty or invalid:', text);
        }
    }

    async handleSkillActivated(skillName) {
        try {
            // Request the actual skill prompt from the main process
            const skillPrompt = await window.electronAPI.getSkillPrompt(skillName);
            
            if (skillPrompt) {
                // Extract the title/first line for display
                const lines = skillPrompt.split('\n').filter(line => line.trim());
                const title = lines.find(line => line.startsWith('#')) || `# ${skillName.toUpperCase()} Mode`;
                const cleanTitle = title.replace(/^#+\s*/, '').trim();
                
                // Show a brief activation message with the skill title
                const icons = {
                    'dsa': '🧠',
                    'behavioral': '💼', 
                    'sales': '💰',
                    'presentation': '🎤',
                    'data-science': '📊',
                    'programming': '💻',
                    'devops': '🚀',
                    'system-design': '🏗️',
                    'negotiation': '🤝'
                };
                
                const icon = icons[skillName] || '🎯';
                this.addMessage(`${icon} ${cleanTitle} - Ready to help!`, 'system');
            } else {
                // Fallback if prompt not found
                this.addMessage(`🎯 ${skillName.toUpperCase()} Mode: Ready to help!`, 'system');
            }
        } catch (error) {
            logger.error('Failed to load skill prompt', { skill: skillName, error: error.message });
            // Fallback message
            this.addMessage(`🎯 ${skillName.toUpperCase()} Mode: Ready to help!`, 'system');
        }
        
        logger.info('Skill activated in chat', { skill: skillName });
    }

    async sendMessage() {
        const text = this.elements.messageInput.value.trim();
        if (text) {
            this.addMessage(text, 'user');
            this.elements.messageInput.value = '';
            
            // Send to main process for session memory storage
            try {
                if (window.electronAPI && window.electronAPI.sendChatMessage) {
                    await window.electronAPI.sendChatMessage(text);
                }
            } catch (error) {
                logger.error('Failed to send chat message to main process', { error: error.message });
            }
            
            logger.debug('User message sent', { textLength: text.length });
        }
    }

    addMessage(text, type = 'user') {        
        if (!this.elements.chatMessages) {
            console.error('❌ Chat messages element not found!');
            return;
        }
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;
        
        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = new Date().toLocaleTimeString();
        
        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        
        // Format assistant messages as markdown
        if (type === 'assistant') {
            textDiv.innerHTML = this.formatMarkdown(text);
        } else {
            textDiv.textContent = text;
        }
        
        messageDiv.appendChild(timeDiv);
        messageDiv.appendChild(textDiv);
        
        this.elements.chatMessages.appendChild(messageDiv);
        
        // Auto-scroll to bottom
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    // Create a live, growing assistant bubble for a streaming response.
    beginStreamingResponse(messageId) {
        this.hideThinkingIndicator();
        if (!this.elements.chatMessages) return;
        // Guard against a duplicate start for the same id.
        if (this.elements.chatMessages.querySelector(`[data-stream-id="${messageId}"]`)) {
            return;
        }
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant streaming';
        messageDiv.setAttribute('data-stream-id', messageId);

        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = new Date().toLocaleTimeString();

        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = '';

        messageDiv.appendChild(timeDiv);
        messageDiv.appendChild(textDiv);
        this.elements.chatMessages.appendChild(messageDiv);
        this._streamBuffers = this._streamBuffers || {};
        this._streamBuffers[messageId] = '';
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    appendStreamingChunk(messageId, delta) {
        if (!delta) return;
        const messageDiv = this.elements.chatMessages &&
            this.elements.chatMessages.querySelector(`[data-stream-id="${messageId}"]`);
        if (!messageDiv) {
            // No start seen (e.g. very fast final) — create the bubble lazily.
            this.beginStreamingResponse(messageId);
            return this.appendStreamingChunk(messageId, delta);
        }
        this._streamBuffers = this._streamBuffers || {};
        this._streamBuffers[messageId] = (this._streamBuffers[messageId] || '') + delta;
        const textDiv = messageDiv.querySelector('.message-text');
        if (textDiv) {
            // Plain text while streaming keeps it fast and avoids half-parsed
            // markdown flicker; the final render formats it properly.
            textDiv.textContent = this._streamBuffers[messageId];
        }
        const atBottom = true;
        if (atBottom) {
            this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
        }
    }

    // Replace the streaming bubble with the formatted final response (markdown
    // text + extracted code snippets), matching non-streaming rendering.
    finalizeStreamingResponse(messageId, response) {
        const messageDiv = messageId && this.elements.chatMessages &&
            this.elements.chatMessages.querySelector(`[data-stream-id="${messageId}"]`);
        if (messageDiv) {
            messageDiv.remove();
        }
        if (this._streamBuffers && messageId) {
            delete this._streamBuffers[messageId];
        }
        this.renderAssistantResponse(response);
    }

    // Split AI response into plain text and code snippets and append to chat
    renderAssistantResponse(response) {
        if (!response || typeof response !== 'string') return;
        const blocks = this.extractCodeBlocks(response);
        const textOnly = this.stripCodeBlocks(response, blocks);
        if (textOnly && textOnly.trim().length) {
            this.addMessage(textOnly, 'assistant');
        }
        blocks.forEach(b => this.addCodeSnippet(b.language, b.code));
    }

    extractCodeBlocks(text) {
        const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
        const blocks = [];
        let match;
        while ((match = codeBlockRegex.exec(text)) !== null) {
            blocks.push({ language: match[1] || 'text', code: (match[2] || '').trim(), fullMatch: match[0] });
        }
        return blocks;
    }

    stripCodeBlocks(text, blocks) {
        let result = text || '';
        blocks.forEach(b => { result = result.replace(b.fullMatch, ''); });
        return result.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
    }

    addCodeSnippet(language, code) {
        if (!this.elements.chatMessages) return;
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant';
        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = new Date().toLocaleTimeString();
        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        const escapedLang = (language || 'text').toUpperCase();
        const escapedCode = this.escapeHtmlForSnippet(code || '');
        textDiv.innerHTML = `
            <div style="font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:6px;">Snippet: ${escapedLang}</div>
            <pre><code>${escapedCode}</code></pre>
        `;
        messageDiv.appendChild(timeDiv);
        messageDiv.appendChild(textDiv);
        this.elements.chatMessages.appendChild(messageDiv);
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    escapeHtmlForSnippet(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatMarkdown(text) {
        if (!text) return '';
        
        try {
            // Use the markdown.js library for proper markdown parsing
            // Try to access markdown library in different contexts
            let markdownLib;
            
            // First try global markdown object (from script tag)
            if (typeof markdown !== 'undefined' && markdown.toHTML) {
                markdownLib = markdown;
            }
            // Then try require (Node.js context)
            else if (typeof require !== 'undefined') {
                try {
                    markdownLib = require('markdown');
                } catch (requireError) {
                    logger.debug('Could not require markdown library:', requireError.message);
                }
            }
            // Finally try window.markdown (browser context)
            else if (typeof window !== 'undefined' && window.markdown) {
                markdownLib = window.markdown;
            }
            
            if (markdownLib && markdownLib.toHTML) {
                return markdownLib.toHTML(text);
            } else {
                logger.warn('Markdown library not available, falling back to basic formatting');
                // Fallback to basic formatting
                return text
                    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\*(.+?)\*/g, '<em>$1</em>')
                    .replace(/`(.+?)`/g, '<code>$1</code>')
                    .replace(/\n/g, '<br>');
            }
        } catch (error) {
            logger.warn('Failed to parse markdown, falling back to plain text', { error: error.message });
            // Fallback to basic formatting
            return text.replace(/\n/g, '<br>');
        }
    }

    showThinkingIndicator() {
        if (!this.elements.chatMessages) return;

        const thinkingDiv = document.createElement('div');
        thinkingDiv.className = 'message assistant thinking';
        thinkingDiv.id = 'thinking-indicator';

        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = new Date().toLocaleTimeString();

        const textDiv = document.createElement('div');
        textDiv.className = 'message-text thinking-dots';
        textDiv.innerHTML = '<span class="dot">•</span><span class="dot">•</span><span class="dot">•</span>';

        thinkingDiv.appendChild(timeDiv);
        thinkingDiv.appendChild(textDiv);

        this.elements.chatMessages.appendChild(thinkingDiv);
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    hideThinkingIndicator() {
        const thinkingIndicator = document.getElementById('thinking-indicator');
        if (thinkingIndicator) {
            thinkingIndicator.remove();
        }
    }

    showInteractionIndicator(text, interactive) {
        if (!this.elements.interactionIndicator || !this.elements.interactionText) return;
        
        this.elements.interactionText.textContent = text;
        this.elements.interactionIndicator.className = `interaction-indicator show ${interactive ? 'interactive' : 'non-interactive'}`;
        
        setTimeout(() => {
            this.elements.interactionIndicator.classList.remove('show');
        }, 2000);
    }

    showListeningAnimation() {
        if (!this.elements.listeningContainer) {
            console.warn('❌ Listening container not found');
            return;
        }
        
        // Show the listening animation
        this.elements.listeningContainer.classList.add('active');
        
        // Start the duration timer
        this.listeningStartTime = Date.now();
        this.listeningTimer = setInterval(() => {
            this.updateListeningDuration();
        }, 100);
        
        // Auto-scroll to show the listening animation
        if (this.elements.chatMessages) {
            this.elements.chatMessages.scrollTop = 0;
        }
    }

    hideListeningAnimation() {
        if (this.elements.listeningContainer) {
            this.elements.listeningContainer.classList.remove('active');
        }
        
        // Clear interim text
        this.clearInterimText();
        
        // Clear the duration timer
        if (this.listeningTimer) {
            clearInterval(this.listeningTimer);
            this.listeningTimer = null;
        }
        
        this.listeningStartTime = null;
    }

    updateListeningDuration() {
        if (!this.listeningStartTime || !this.elements.listeningDuration) return;
        
        const elapsed = Date.now() - this.listeningStartTime;
        const seconds = Math.floor(elapsed / 1000);
        const milliseconds = Math.floor((elapsed % 1000) / 100);
        
        const formattedTime = `${seconds.toString().padStart(2, '0')}:${milliseconds}`;
        this.elements.listeningDuration.textContent = formattedTime;
    }

    showInterimText(text) {
        if (!this.elements.listeningContainer) return;
        
        // Find or create interim text element
        let interimElement = this.elements.listeningContainer.querySelector('.interim-text');
        if (!interimElement) {
            interimElement = document.createElement('div');
            interimElement.className = 'interim-text';
            interimElement.style.cssText = `
                color: rgba(255, 255, 255, 0.8);
                font-size: 12px;
                font-style: italic;
                margin-top: 10px;
                padding: 8px;
                background: rgba(76, 175, 80, 0.2);
                border-radius: 6px;
                min-height: 20px;
                border: 1px dashed rgba(76, 175, 80, 0.4);
            `;
            this.elements.listeningContainer.appendChild(interimElement);
        }
        
        interimElement.textContent = text || 'Waiting for speech...';
    }

    clearInterimText() {
        if (!this.elements.listeningContainer) return;
        
        const interimElement = this.elements.listeningContainer.querySelector('.interim-text');
        if (interimElement) {
            interimElement.remove();
        }
    }
}

    // Initialize when DOM is loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            new ChatWindowUI();
        });
    } else {
        new ChatWindowUI();
    }

} catch (error) {
    console.error('💥 CHAT-WINDOW.JS: Script execution failed!', error);
    console.error('💥 CHAT-WINDOW.JS: Error stack:', error.stack);
}
