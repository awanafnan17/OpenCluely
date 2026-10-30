const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

test.describe('OpenCluely Real Electron E2E Integration Suite', () => {
  let electronApp;
  let chatPage;
  let overlayPage;

  test.beforeAll(async () => {
    const electronPath = require('electron');
    // Launch actual Electron application with test environment flags
    electronApp = await electron.launch({
      executablePath: electronPath,
      args: ['.'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        NODE_ENV: 'test',
        OPENCLUELY_E2E_TEST: '1',
        ELECTRON_ENABLE_LOGGING: '1'
      }
    });

    // Wait for first window to be created and loaded
    chatPage = await electronApp.firstWindow();
    await chatPage.waitForLoadState('domcontentloaded');

    const windows = await electronApp.windows();
    expect(windows.length).toBeGreaterThanOrEqual(1);

    // Locate chat page and overlay page
    for (const win of windows) {
      const url = win.url();
      if (url.includes('chat.html')) {
        chatPage = win;
      } else {
        overlayPage = win;
      }
    }

    if (!chatPage) {
      chatPage = await electronApp.firstWindow();
    }
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test('Req 2: Verify BrowserWindows and DOM health', async () => {
    expect(chatPage).toBeDefined();
    const url = chatPage.url();
    expect(url).toContain('chat.html');
    
    // Verify renderer JS is loaded and active
    const isUIActive = await chatPage.evaluate(() => typeof window.electronAPI === 'object');
    expect(isUIActive).toBe(true);
  });

  test('Req 3: Verify Real Chat UI controls and text exclusions', async () => {
    // Buttons present
    await expect(chatPage.locator('#selectBriefBtn')).toBeVisible();
    await expect(chatPage.locator('#previewBriefBtn')).toBeVisible();
    await expect(chatPage.locator('#audioSourceSelect')).toBeVisible();
    await expect(chatPage.locator('#refreshAudioSourcesBtn')).toBeVisible();
    await expect(chatPage.locator('#startCallBtn')).toBeVisible();
    await expect(chatPage.locator('#endCallBtn')).toBeVisible();
    await expect(chatPage.locator('#micButton')).toBeVisible();

    // Verify mic button has Manual Microphone Diagnostic description
    const micTitle = await chatPage.locator('#micButton').getAttribute('title');
    expect(micTitle).toContain('Manual Microphone Diagnostic');

    // Assert old misleading text 'press ⌘+R' is ABSENT
    const bodyText = await chatPage.innerText('body');
    expect(bodyText).not.toContain('press ⌘+R');
    expect(bodyText).not.toContain('DSA Interview Helper Agent');
  });

  test('Req 4: Automated Brief Selection with Fixtures', async () => {
    const fixtureAlpha = path.join(__dirname, '../fixtures/client-alpha.md');
    
    // Inject client-alpha.md via test API
    const loadResult = await chatPage.evaluate(async (file) => {
      return await window.electronAPI.selectCallBriefFixture(file);
    }, fixtureAlpha);

    expect(loadResult.success).toBe(true);

    // Verify brief filename displayed
    const filenameText = await chatPage.locator('#briefFilename').innerText();
    expect(filenameText).toContain('client-alpha.md');

    // Click Preview Brief
    await chatPage.locator('#previewBriefBtn').click();
    await expect(chatPage.locator('#briefPreviewModal')).toBeVisible();
    
    const previewContent = await chatPage.locator('#modalBriefBody').innerText();
    expect(previewContent).toContain('Atlas Dashboard');
    expect(previewContent).toContain('React and Node.js');

    // Close preview modal
    await chatPage.locator('#closeModalBtn').click();
    await expect(chatPage.locator('#briefPreviewModal')).toBeHidden();

    // Load client-beta.md and assert context replacement
    const fixtureBeta = path.join(__dirname, '../fixtures/client-beta.md');
    const betaResult = await chatPage.evaluate(async (file) => {
      return await window.electronAPI.selectCallBriefFixture(file);
    }, fixtureBeta);
    expect(betaResult.success).toBe(true);

    const betaFilename = await chatPage.locator('#briefFilename').innerText();
    expect(betaFilename).toContain('client-beta.md');

    // Restore client-alpha.md for remaining tests
    await chatPage.evaluate(async (file) => {
      return await window.electronAPI.selectCallBriefFixture(file);
    }, fixtureAlpha);
  });

  test('Req 5: Audio Source UI & Enumeration', async () => {
    // Click Refresh Audio Sources
    await chatPage.locator('#refreshAudioSourcesBtn').click();

    // Verify options in select dropdown
    const optionsCount = await chatPage.locator('#audioSourceSelect option').count();
    expect(optionsCount).toBeGreaterThanOrEqual(1);

    const firstOptionText = await chatPage.locator('#audioSourceSelect option').first().innerText();
    expect(firstOptionText).toContain('Primary Display Audio');
  });

  test('Req 6 & 8 & 17: Start Live Call UI State, Execution & Purge', async () => {
    // Ensure Ollama status check passes
    const ollamaStatus = await chatPage.evaluate(async () => {
      return await window.electronAPI.checkOllamaStatus();
    });

    if (!ollamaStatus.connected) {
      console.log('⚠️ Local Ollama not running, skipping live generation segment');
      return;
    }

    // Click Start Live Call
    await chatPage.locator('#startCallBtn').click();

    // Wait for startup or verified status
    await chatPage.waitForTimeout(2000);

    // Verify live call active status in chat
    const chatContent = await chatPage.innerText('#chatMessages');
    expect(chatContent).toContain('Preloading models');

    // Rapid double-click check
    const doubleStartRes = await chatPage.evaluate(async () => {
      return await window.electronAPI.startLiveCall();
    });
    expect(doubleStartRes.success).toBe(false);
    expect(doubleStartRes.error).toContain('already starting or active');

    // Test End Call & Purge
    await chatPage.locator('#endCallBtn').click();
    await chatPage.waitForTimeout(1000);

    const filenameAfterPurge = await chatPage.locator('#briefFilename').innerText();
    expect(filenameAfterPurge).toContain('No Client Brief Selected');
  });
});
