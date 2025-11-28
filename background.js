// Background service worker for Steam Video Downloader

let offscreenDocumentCreated = false;
const pendingRequests = new Map();

// Create offscreen document for FFmpeg processing
async function ensureOffscreenDocument() {
  if (offscreenDocumentCreated) return;

  try {
    // Check if already exists
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
      offscreenDocumentCreated = true;
      return;
    }

    // Create offscreen document
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'FFmpeg video processing'
    });

    offscreenDocumentCreated = true;
    console.log('Offscreen document created');
  } catch (error) {
    console.error('Failed to create offscreen document:', error);
    throw error;
  }
}

// Generate unique request ID
function generateRequestId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'muxRequest') {
    handleMuxRequest(message, sender.tab?.id);
    return true;
  }

  if (message.action === 'muxProgress') {
    // Forward progress to content script
    const request = pendingRequests.get(message.requestId);
    if (request && request.tabId) {
      chrome.tabs.sendMessage(request.tabId, {
        action: 'muxProgress',
        progress: message.progress,
        status: message.status
      });
    }
  }

  if (message.action === 'muxComplete') {
    // Forward result to content script
    const request = pendingRequests.get(message.requestId);
    if (request && request.tabId) {
      chrome.tabs.sendMessage(request.tabId, {
        action: 'muxComplete',
        data: message.data
      });
      pendingRequests.delete(message.requestId);
    }
  }

  if (message.action === 'muxError') {
    // Forward error to content script
    const request = pendingRequests.get(message.requestId);
    if (request && request.tabId) {
      chrome.tabs.sendMessage(request.tabId, {
        action: 'muxError',
        error: message.error
      });
      pendingRequests.delete(message.requestId);
    }
  }

  return true;
});

// Handle mux request from content script
async function handleMuxRequest(message, tabId) {
  try {
    console.log('Background: Received mux request, video size:', message.videoData?.length, 'audio size:', message.audioData?.length);

    await ensureOffscreenDocument();
    console.log('Background: Offscreen document ready');

    const requestId = generateRequestId();
    pendingRequests.set(requestId, { tabId });

    // Send status to content script
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: 'muxProgress',
        progress: 0,
        status: 'Preparing FFmpeg...'
      });
    }

    // Send to offscreen document
    console.log('Background: Sending to offscreen document...');
    chrome.runtime.sendMessage({
      action: 'mux',
      videoData: message.videoData,
      audioData: message.audioData,
      requestId
    });
  } catch (error) {
    console.error('Background: Mux request failed:', error);
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: 'muxError',
        error: error.message
      });
    }
  }
}

// Pre-create offscreen document on install
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await ensureOffscreenDocument();
  } catch (error) {
    console.log('Will create offscreen document when needed');
  }
});
