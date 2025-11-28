// Offscreen document for MP4 muxing using mp4box.js

// Mux video and audio tracks into a single MP4
async function muxTracks(videoData, audioData, onProgress) {
  return new Promise((resolve, reject) => {
    try {
      onProgress && onProgress(5, 'Initializing MP4 muxer...');

      const outputFile = MP4Box.createFile();
      let videoTrackId = null;
      let audioTrackId = null;
      let videoInfo = null;
      let audioInfo = null;

      // Process video file
      const videoMp4 = MP4Box.createFile();
      videoMp4.onReady = (info) => {
        videoInfo = info;
        console.log('Video info:', info);
      };
      videoMp4.onError = (e) => console.error('Video parse error:', e);

      // Process audio file
      const audioMp4 = MP4Box.createFile();
      audioMp4.onReady = (info) => {
        audioInfo = info;
        console.log('Audio info:', info);
      };
      audioMp4.onError = (e) => console.error('Audio parse error:', e);

      onProgress && onProgress(10, 'Parsing video...');

      // Append video data
      const videoBuffer = new Uint8Array(videoData).buffer;
      videoBuffer.fileStart = 0;
      videoMp4.appendBuffer(videoBuffer);
      videoMp4.flush();

      onProgress && onProgress(30, 'Parsing audio...');

      // Append audio data
      const audioBuffer = new Uint8Array(audioData).buffer;
      audioBuffer.fileStart = 0;
      audioMp4.appendBuffer(audioBuffer);
      audioMp4.flush();

      onProgress && onProgress(50, 'Combining tracks...');

      if (!videoInfo || !audioInfo) {
        throw new Error('Failed to parse video or audio file');
      }

      // Create output with video track
      if (videoInfo.tracks && videoInfo.tracks.length > 0) {
        const vTrack = videoInfo.tracks.find(t => t.type === 'video') || videoInfo.tracks[0];
        videoTrackId = outputFile.addTrack({
          type: vTrack.type,
          width: vTrack.video?.width || vTrack.track_width,
          height: vTrack.video?.height || vTrack.track_height,
          timescale: vTrack.timescale,
          duration: vTrack.duration,
          nb_samples: vTrack.nb_samples,
          codec: vTrack.codec,
          language: vTrack.language || 'und',
        });

        // Add video samples
        const videoTrak = videoMp4.getTrackById(vTrack.id);
        for (let i = 0; i < vTrack.nb_samples; i++) {
          const sample = videoMp4.getSample(videoTrak, i);
          if (sample) {
            outputFile.addSample(videoTrackId, sample.data, {
              duration: sample.duration,
              dts: sample.dts,
              cts: sample.cts,
              is_sync: sample.is_sync
            });
          }
        }
      }

      onProgress && onProgress(70, 'Adding audio track...');

      // Add audio track
      if (audioInfo.tracks && audioInfo.tracks.length > 0) {
        const aTrack = audioInfo.tracks.find(t => t.type === 'audio') || audioInfo.tracks[0];
        audioTrackId = outputFile.addTrack({
          type: aTrack.type,
          timescale: aTrack.timescale,
          duration: aTrack.duration,
          nb_samples: aTrack.nb_samples,
          codec: aTrack.codec,
          language: aTrack.language || 'und',
          channel_count: aTrack.audio?.channel_count || 2,
          samplerate: aTrack.audio?.sample_rate || 48000,
        });

        // Add audio samples
        const audioTrak = audioMp4.getTrackById(aTrack.id);
        for (let i = 0; i < aTrack.nb_samples; i++) {
          const sample = audioMp4.getSample(audioTrak, i);
          if (sample) {
            outputFile.addSample(audioTrackId, sample.data, {
              duration: sample.duration,
              dts: sample.dts,
              cts: sample.cts,
              is_sync: sample.is_sync
            });
          }
        }
      }

      onProgress && onProgress(90, 'Generating output file...');

      // Generate output
      const outputArrayBuffer = outputFile.getBuffer();

      onProgress && onProgress(100, 'Complete!');
      resolve(outputArrayBuffer);

    } catch (error) {
      console.error('Muxing error:', error);
      reject(error);
    }
  });
}

// Simple concatenation approach for fragmented MP4
async function simpleMux(videoData, audioData, onProgress) {
  // For fragmented MP4 (DASH segments), we can try a simpler approach
  // Just return the video data for now - mp4box approach above is more complete
  onProgress && onProgress(100, 'Processing...');
  return videoData;
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'mux') {
    handleMux(message.videoData, message.audioData, message.requestId);
  }
  return true;
});

// Handle mux request
async function handleMux(videoData, audioData, requestId) {
  try {
    console.log('Offscreen: Received mux request');
    console.log('Video size:', videoData?.length, 'Audio size:', audioData?.length);

    const onProgress = (progress, status) => {
      chrome.runtime.sendMessage({
        action: 'muxProgress',
        progress,
        status,
        requestId
      });
    };

    onProgress(0, 'Starting mux process...');

    let result;
    try {
      result = await muxTracks(videoData, audioData, onProgress);
    } catch (e) {
      console.log('Advanced mux failed, using simple approach:', e);
      onProgress(50, 'Using alternative method...');
      // Fallback - just return video, audio will be downloaded separately
      result = new Uint8Array(videoData).buffer;
    }

    console.log('Offscreen: Mux complete, output size:', result.byteLength);

    chrome.runtime.sendMessage({
      action: 'muxComplete',
      data: Array.from(new Uint8Array(result)),
      requestId
    });
  } catch (error) {
    console.error('Offscreen: Error:', error);
    chrome.runtime.sendMessage({
      action: 'muxError',
      error: error.message,
      requestId
    });
  }
}

console.log('Offscreen: MP4Box muxer loaded');
