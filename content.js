// Steam Video Downloader - Content Script
// Downloads Steam DASH videos with integrated FFmpeg muxing

(function() {
  'use strict';

  const PROCESSED_ATTR = 'data-svd-processed';
  let isDownloading = false;

  // Binary-level MP4 muxing for fragmented MP4 (DASH segments)
  async function binaryMuxFragmentedMP4(videoData, audioData, onProgress) {
    onProgress && onProgress('Analyzing MP4 structure...');

    const videoView = new DataView(videoData);
    const audioView = new DataView(audioData);

    // Helper to read box header
    function readBoxHeader(view, offset) {
      if (offset + 8 > view.byteLength) return null;
      let size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );
      let headerSize = 8;
      if (size === 1) {
        // 64-bit size
        size = Number(view.getBigUint64(offset + 8));
        headerSize = 16;
      } else if (size === 0) {
        // Box extends to end of file
        size = view.byteLength - offset;
      }
      return { size, type, headerSize, offset };
    }

    // Parse all top-level boxes
    function parseBoxes(view) {
      const boxes = [];
      let offset = 0;
      while (offset < view.byteLength) {
        const box = readBoxHeader(view, offset);
        if (!box || box.size < 8) break;
        boxes.push(box);
        offset += box.size;
      }
      return boxes;
    }

    const videoBoxes = parseBoxes(videoView);
    const audioBoxes = parseBoxes(audioView);

    console.log('Video boxes:', videoBoxes.map(b => b.type + ':' + b.size));
    console.log('Audio boxes:', audioBoxes.map(b => b.type + ':' + b.size));

    // Find key boxes
    const videoFtyp = videoBoxes.find(b => b.type === 'ftyp');
    const videoMoov = videoBoxes.find(b => b.type === 'moov');
    const audioMoov = audioBoxes.find(b => b.type === 'moov');

    if (!videoFtyp || !videoMoov || !audioMoov) {
      throw new Error('Missing required boxes');
    }

    onProgress && onProgress('Merging tracks...');

    // Get moov data
    const videoMoovData = new Uint8Array(videoData, videoMoov.offset, videoMoov.size);
    const audioMoovData = new Uint8Array(audioData, audioMoov.offset, audioMoov.size);

    // Extract audio trak and trex (for mvex)
    const audioTrakBox = findSubBox(audioMoovData, 'trak');
    const audioMvexBox = findSubBox(audioMoovData, 'mvex');
    let audioTrexBox = null;
    if (audioMvexBox) {
      audioTrexBox = findSubBox(audioMvexBox, 'trex');
    }

    if (!audioTrakBox) {
      throw new Error('No audio track found');
    }

    console.log('Found audio trak:', audioTrakBox.length, 'trex:', audioTrexBox?.length);

    // Create merged moov with both tracks and both trex entries
    const mergedMoov = createMergedMoov(videoMoovData, audioTrakBox, audioTrexBox);

    // Collect video fragments (styp + sidx + moof + mdat groups)
    const videoFragments = [];
    for (let i = 0; i < videoBoxes.length; i++) {
      const box = videoBoxes[i];
      if (box.type === 'styp' || box.type === 'sidx' || box.type === 'moof' || box.type === 'mdat') {
        videoFragments.push({
          type: box.type,
          data: new Uint8Array(videoData, box.offset, box.size)
        });
      }
    }

    // Collect audio fragments and update track IDs
    const audioFragments = [];
    for (let i = 0; i < audioBoxes.length; i++) {
      const box = audioBoxes[i];
      if (box.type === 'styp' || box.type === 'sidx') {
        audioFragments.push({
          type: box.type,
          data: new Uint8Array(audioData, box.offset, box.size)
        });
      } else if (box.type === 'moof') {
        const moofData = new Uint8Array(audioData.slice(box.offset, box.offset + box.size));
        updateTrackIdInMoof(moofData, 2);
        // Also update sidx if present (track reference)
        audioFragments.push({ type: 'moof', data: moofData });
      } else if (box.type === 'mdat') {
        audioFragments.push({
          type: box.type,
          data: new Uint8Array(audioData, box.offset, box.size)
        });
      }
    }

    // Also update track reference in audio sidx boxes
    for (const frag of audioFragments) {
      if (frag.type === 'sidx') {
        updateTrackIdInSidx(frag.data, 2);
      }
    }

    onProgress && onProgress('Building output file...');

    // Calculate total size
    const ftypData = new Uint8Array(videoData, videoFtyp.offset, videoFtyp.size);
    let totalSize = ftypData.length + mergedMoov.length;
    for (const frag of videoFragments) totalSize += frag.data.length;
    for (const frag of audioFragments) totalSize += frag.data.length;

    // Build output
    const output = new Uint8Array(totalSize);
    let writeOffset = 0;

    // Write ftyp
    output.set(ftypData, writeOffset);
    writeOffset += ftypData.length;

    // Write merged moov
    output.set(mergedMoov, writeOffset);
    writeOffset += mergedMoov.length;

    // Write video fragments first, then audio fragments
    for (const frag of videoFragments) {
      output.set(frag.data, writeOffset);
      writeOffset += frag.data.length;
    }
    for (const frag of audioFragments) {
      output.set(frag.data, writeOffset);
      writeOffset += frag.data.length;
    }

    console.log('Binary mux complete, output size:', output.length);
    return output.buffer;
  }

  // Update track reference in sidx box
  function updateTrackIdInSidx(sidxData, newTrackId) {
    if (sidxData.length < 16) return;
    const view = new DataView(sidxData.buffer, sidxData.byteOffset, sidxData.byteLength);
    // sidx: header(8) + version(1) + flags(3) + reference_ID(4)
    view.setUint32(12, newTrackId);
  }

  // Create merged moov box with both video and audio tracks
  function createMergedMoov(videoMoovData, audioTrakBox, audioTrexBox) {
    // Update audio trak track_ID to 2
    const audioTrakCopy = new Uint8Array(audioTrakBox);
    updateTrackIdInTrak(audioTrakCopy, 2);

    // Find mvex in video moov and get its position
    const videoMvex = findSubBoxWithOffset(videoMoovData, 'mvex');

    if (!videoMvex || !audioTrexBox) {
      // No mvex - just append trak
      const newSize = videoMoovData.length + audioTrakCopy.length;
      const result = new Uint8Array(newSize);
      result.set(videoMoovData);
      result.set(audioTrakCopy, videoMoovData.length);
      const view = new DataView(result.buffer);
      view.setUint32(0, newSize);
      return result;
    }

    // Update audio trex track_ID to 2
    const audioTrexCopy = new Uint8Array(audioTrexBox);
    updateTrackIdInTrex(audioTrexCopy, 2);

    // Build new moov:
    // 1. Copy everything before mvex
    // 2. Insert audio trak before mvex
    // 3. Copy mvex with added audio trex

    const mvexOffset = videoMvex.offset;
    const mvexSize = videoMvex.size;
    const beforeMvex = videoMoovData.slice(0, mvexOffset);
    const oldMvex = videoMoovData.slice(mvexOffset, mvexOffset + mvexSize);

    // Create new mvex with audio trex added
    const newMvexSize = mvexSize + audioTrexCopy.length;
    const newMvex = new Uint8Array(newMvexSize);
    newMvex.set(oldMvex);
    newMvex.set(audioTrexCopy, mvexSize);
    // Update mvex size
    const mvexView = new DataView(newMvex.buffer);
    mvexView.setUint32(0, newMvexSize);

    // Final moov: beforeMvex + audioTrak + newMvex
    const newMoovSize = beforeMvex.length + audioTrakCopy.length + newMvex.length;
    const result = new Uint8Array(newMoovSize);
    let offset = 0;
    result.set(beforeMvex, offset);
    offset += beforeMvex.length;
    result.set(audioTrakCopy, offset);
    offset += audioTrakCopy.length;
    result.set(newMvex, offset);

    // Update moov size
    const view = new DataView(result.buffer);
    view.setUint32(0, newMoovSize);

    console.log('Created merged moov, size:', newMoovSize, 'with audio trak and trex');
    return result;
  }

  // Find sub-box with offset info
  function findSubBoxWithOffset(data, targetType) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 8;
    while (offset < data.length - 8) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
      if (size < 8 || offset + size > data.length) break;
      if (type === targetType) {
        return { offset, size, data: data.slice(offset, offset + size) };
      }
      offset += size;
    }
    return null;
  }

  // Update track_ID in trex box
  function updateTrackIdInTrex(trexData, newTrackId) {
    if (trexData.length < 16) return;
    const view = new DataView(trexData.buffer, trexData.byteOffset, trexData.byteLength);
    // trex: header(8) + version(1) + flags(3) + track_ID(4)
    view.setUint32(12, newTrackId);
    console.log('Updated trex track_ID to', newTrackId);
  }

  // Extract raw stsd box from moov in original data
  function extractStsdFromMoov(data) {
    const view = new DataView(data);

    // Find moov box
    let offset = 0;
    while (offset < data.byteLength - 8) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4), view.getUint8(offset + 5),
        view.getUint8(offset + 6), view.getUint8(offset + 7)
      );
      if (size < 8 || offset + size > data.byteLength) break;

      if (type === 'moov') {
        // Search inside moov for trak -> mdia -> minf -> stbl -> stsd
        return findStsdInBox(new Uint8Array(data, offset, size), 8);
      }
      offset += size;
    }
    return null;
  }

  // Recursively find stsd box
  function findStsdInBox(data, startOffset) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = startOffset;

    while (offset < data.length - 8) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]
      );

      if (size < 8 || offset + size > data.length) break;

      if (type === 'stsd') {
        // Found it! Return the raw bytes
        return data.slice(offset, offset + size);
      }

      // Recurse into container boxes
      if (type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') {
        const result = findStsdInBox(data.slice(offset, offset + size), 8);
        if (result) return result;
      }

      offset += size;
    }
    return null;
  }

  // New approach: defragment using raw stsd from original files
  async function defragmentWithRawStsd(videoData, audioData, onProgress) {
    return new Promise((resolve, reject) => {
      // Extract raw stsd boxes from original files
      const videoStsd = extractStsdFromMoov(videoData);
      const audioStsd = extractStsdFromMoov(audioData);

      console.log('Extracted stsd - video:', videoStsd?.length, 'audio:', audioStsd?.length);

      if (videoStsd) {
        // Log the codec type from stsd (first 4 bytes after stsd header)
        const videoCodec = videoStsd.length > 16 ?
          String.fromCharCode(videoStsd[12], videoStsd[13], videoStsd[14], videoStsd[15]) : 'unknown';
        console.log('Video stsd codec:', videoCodec);
      }
      if (audioStsd) {
        const audioCodec = audioStsd.length > 16 ?
          String.fromCharCode(audioStsd[12], audioStsd[13], audioStsd[14], audioStsd[15]) : 'unknown';
        console.log('Audio stsd codec:', audioCodec);
      }

      if (!videoStsd) {
        reject(new Error('Could not extract video stsd'));
        return;
      }

      const file = MP4Box.createFile();
      let fileInfo = null;
      const trackSamples = {};
      let resolved = false;

      file.onReady = (info) => {
        fileInfo = info;
        console.log('Defrag2: Tracks:', info.tracks.map(t => `${t.id}:${t.type}:${t.nb_samples}samples`));

        for (const track of info.tracks) {
          trackSamples[track.id] = [];
          file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
        }
        file.start();
      };

      file.onSamples = (trackId, user, samples) => {
        if (resolved) return;
        console.log(`Defrag2: Track ${trackId} got ${samples.length} samples`);
        trackSamples[trackId].push(...samples);

        let allDone = fileInfo && fileInfo.tracks.every(t =>
          trackSamples[t.id] && trackSamples[t.id].length >= t.nb_samples
        );

        if (allDone && !resolved) {
          resolved = true;
          buildOutput();
        }
      };

      file.onError = (e) => {
        if (!resolved) {
          resolved = true;
          reject(e);
        }
      };

      function buildOutput() {
        try {
          onProgress && onProgress('Building standard MP4...');

          const tracks = [];
          for (const track of fileInfo.tracks) {
            const samples = trackSamples[track.id];
            if (!samples || samples.length === 0) continue;

            // Verify all samples have data
            let validSamples = 0;
            let totalDataSize = 0;
            for (const s of samples) {
              if (s.data && s.data.byteLength > 0) {
                validSamples++;
                totalDataSize += s.data.byteLength;
              }
            }
            console.log(`Defrag2: Track ${track.id} (${track.type}): ${validSamples}/${samples.length} valid samples, ${totalDataSize} bytes`);

            // Calculate duration from samples if track duration is 0 or missing
            const filteredSamples = samples.filter(s => s.data && s.data.byteLength > 0);
            let calculatedDuration = track.duration;
            if (!calculatedDuration || calculatedDuration === 0) {
              // Sum up all sample durations
              calculatedDuration = filteredSamples.reduce((sum, s) => sum + (s.duration || 0), 0);
            }
            console.log(`Defrag2: Track ${track.id} (${track.type}) - timescale: ${track.timescale}, duration: ${track.duration}, calculated: ${calculatedDuration}`);

            tracks.push({
              id: tracks.length + 1,
              type: track.type,
              timescale: track.timescale,
              duration: calculatedDuration,
              width: track.video?.width || track.track_width || 0,
              height: track.video?.height || track.track_height || 0,
              samples: filteredSamples,
              rawStsd: track.type === 'video' ? videoStsd : audioStsd
            });
          }

          // Sort tracks: video first, audio second
          tracks.sort((a, b) => (a.type === 'video' ? -1 : 1));

          console.log('Defrag2: Building MP4 with tracks:', tracks.map(t => `${t.type}:${t.samples.length}samples`));
          const output = buildMP4WithRawStsd(tracks, fileInfo);
          console.log('Defrag2: Built MP4, size:', output.byteLength);
          resolve(output);
        } catch (e) {
          console.error('Defrag2 build error:', e);
          reject(e);
        }
      }

      // Parse both video and audio to get combined samples
      // First create the fragmented version, then parse it
      binaryMuxFragmentedMP4(videoData, audioData, onProgress).then(fragmented => {
        const buf = fragmented.slice(0);
        buf.fileStart = 0;
        file.appendBuffer(buf);
        file.flush();
      }).catch(reject);

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Timeout'));
        }
      }, 20000);
    });
  }

  // Build MP4 with raw stsd boxes
  function buildMP4WithRawStsd(tracks, fileInfo) {
    function makeBox(type, content) {
      const size = 8 + content.length;
      const box = new Uint8Array(size);
      const view = new DataView(box.buffer);
      view.setUint32(0, size);
      box[4] = type.charCodeAt(0);
      box[5] = type.charCodeAt(1);
      box[6] = type.charCodeAt(2);
      box[7] = type.charCodeAt(3);
      box.set(content, 8);
      return box;
    }

    function concat(...arrays) {
      const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
      }
      return result;
    }

    // ftyp
    const ftypContent = new Uint8Array(20);
    ftypContent[0] = 0x69; ftypContent[1] = 0x73; ftypContent[2] = 0x6F; ftypContent[3] = 0x6D; // isom
    new DataView(ftypContent.buffer).setUint32(4, 0x200);
    ftypContent[8] = 0x69; ftypContent[9] = 0x73; ftypContent[10] = 0x6F; ftypContent[11] = 0x6D; // isom
    ftypContent[12] = 0x69; ftypContent[13] = 0x73; ftypContent[14] = 0x6F; ftypContent[15] = 0x32; // iso2
    ftypContent[16] = 0x61; ftypContent[17] = 0x76; ftypContent[18] = 0x63; ftypContent[19] = 0x31; // avc1
    const ftyp = makeBox('ftyp', ftypContent);

    // mvhd
    const movieTimescale = 1000;
    let maxDuration = 0;
    for (const t of tracks) {
      const d = t.duration * movieTimescale / t.timescale;
      console.log(`BuildMP4: Track ${t.type} duration in movie timescale: ${d} (raw: ${t.duration}, timescale: ${t.timescale})`);
      if (d > maxDuration) maxDuration = d;
    }
    console.log(`BuildMP4: Movie duration: ${maxDuration}ms`);

    const mvhdContent = new Uint8Array(100);
    const mvhdView = new DataView(mvhdContent.buffer);
    mvhdView.setUint32(12, movieTimescale);
    mvhdView.setUint32(16, Math.round(maxDuration));
    mvhdView.setUint32(20, 0x00010000); // rate
    mvhdView.setUint16(24, 0x0100); // volume
    mvhdView.setUint32(36, 0x00010000);
    mvhdView.setUint32(52, 0x00010000);
    mvhdView.setUint32(68, 0x40000000);
    mvhdView.setUint32(96, tracks.length + 1);
    const mvhd = makeBox('mvhd', mvhdContent);

    // Collect all sample data first
    const allSampleData = [];
    for (const track of tracks) {
      for (const sample of track.samples) {
        if (sample.data) allSampleData.push(new Uint8Array(sample.data));
      }
    }
    const mdatContent = concat(...allSampleData);

    // Build traks with placeholder offsets first to calculate moov size
    function buildTrak(track, dataOffset) {
      const trackDuration = Math.round(track.duration * movieTimescale / track.timescale);

      // tkhd
      const tkhdContent = new Uint8Array(84);
      const tkhdView = new DataView(tkhdContent.buffer);
      tkhdView.setUint32(0, 0x00000003);
      tkhdView.setUint32(12, track.id);
      tkhdView.setUint32(20, trackDuration);
      tkhdView.setUint16(36, track.type === 'audio' ? 0x0100 : 0);
      tkhdView.setUint32(40, 0x00010000);
      tkhdView.setUint32(56, 0x00010000);
      tkhdView.setUint32(72, 0x40000000);
      tkhdView.setUint32(76, track.width << 16);
      tkhdView.setUint32(80, track.height << 16);
      const tkhd = makeBox('tkhd', tkhdContent);

      // mdhd
      const mdhdContent = new Uint8Array(24);
      const mdhdView = new DataView(mdhdContent.buffer);
      mdhdView.setUint32(12, track.timescale);
      mdhdView.setUint32(16, track.duration);
      mdhdView.setUint16(20, 0x55C4);
      const mdhd = makeBox('mdhd', mdhdContent);

      // hdlr
      const handlerType = track.type === 'video' ? 'vide' : 'soun';
      const handlerName = track.type === 'video' ? 'VideoHandler' : 'SoundHandler';
      const hdlrContent = new Uint8Array(25 + handlerName.length);
      hdlrContent[8] = handlerType.charCodeAt(0);
      hdlrContent[9] = handlerType.charCodeAt(1);
      hdlrContent[10] = handlerType.charCodeAt(2);
      hdlrContent[11] = handlerType.charCodeAt(3);
      for (let i = 0; i < handlerName.length; i++) hdlrContent[24 + i] = handlerName.charCodeAt(i);
      const hdlr = makeBox('hdlr', hdlrContent);

      // vmhd/smhd
      const mediaHeader = track.type === 'video'
        ? makeBox('vmhd', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
        : makeBox('smhd', new Uint8Array(8));

      // dinf/dref
      const urlBox = makeBox('url ', new Uint8Array([0, 0, 0, 1]));
      const dref = makeBox('dref', concat(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), urlBox));
      const dinf = makeBox('dinf', dref);

      // stsd - use raw stsd from original file!
      const stsd = track.rawStsd || makeBox('stsd', new Uint8Array(8));

      // stts
      const sttsEntries = [];
      let currDur = track.samples[0]?.duration || 1;
      let count = 0;
      for (const s of track.samples) {
        if (s.duration === currDur) count++;
        else {
          sttsEntries.push({ count, dur: currDur });
          currDur = s.duration;
          count = 1;
        }
      }
      if (count > 0) sttsEntries.push({ count, dur: currDur });

      const sttsContent = new Uint8Array(8 + sttsEntries.length * 8);
      const sttsView = new DataView(sttsContent.buffer);
      sttsView.setUint32(4, sttsEntries.length);
      for (let i = 0; i < sttsEntries.length; i++) {
        sttsView.setUint32(8 + i * 8, sttsEntries[i].count);
        sttsView.setUint32(12 + i * 8, sttsEntries[i].dur);
      }
      const stts = makeBox('stts', sttsContent);

      // stsc
      const stscContent = new Uint8Array(20);
      const stscView = new DataView(stscContent.buffer);
      stscView.setUint32(4, 1);
      stscView.setUint32(8, 1);
      stscView.setUint32(12, track.samples.length);
      stscView.setUint32(16, 1);
      const stsc = makeBox('stsc', stscContent);

      // stsz
      const stszContent = new Uint8Array(12 + track.samples.length * 4);
      const stszView = new DataView(stszContent.buffer);
      stszView.setUint32(8, track.samples.length);
      for (let i = 0; i < track.samples.length; i++) {
        stszView.setUint32(12 + i * 4, track.samples[i].data?.byteLength || 0);
      }
      const stsz = makeBox('stsz', stszContent);

      // stco
      const stcoContent = new Uint8Array(12);
      const stcoView = new DataView(stcoContent.buffer);
      stcoView.setUint32(4, 1);
      stcoView.setUint32(8, dataOffset);
      const stco = makeBox('stco', stcoContent);

      // stss for video
      let stss = null;
      if (track.type === 'video') {
        const syncSamples = [];
        for (let i = 0; i < track.samples.length; i++) {
          if (track.samples[i].is_sync) syncSamples.push(i + 1);
        }
        if (syncSamples.length > 0 && syncSamples.length < track.samples.length) {
          const stssContent = new Uint8Array(8 + syncSamples.length * 4);
          const stssView = new DataView(stssContent.buffer);
          stssView.setUint32(4, syncSamples.length);
          for (let i = 0; i < syncSamples.length; i++) {
            stssView.setUint32(8 + i * 4, syncSamples[i]);
          }
          stss = makeBox('stss', stssContent);
        }
      }

      // ctts if needed
      let ctts = null;
      let needsCtts = track.samples.some(s => s.cts !== s.dts);
      if (needsCtts) {
        const cttsEntries = [];
        let currOff = (track.samples[0]?.cts || 0) - (track.samples[0]?.dts || 0);
        let cnt = 0;
        for (const s of track.samples) {
          const off = (s.cts || 0) - (s.dts || 0);
          if (off === currOff) cnt++;
          else {
            cttsEntries.push({ count: cnt, offset: currOff });
            currOff = off;
            cnt = 1;
          }
        }
        if (cnt > 0) cttsEntries.push({ count: cnt, offset: currOff });

        const cttsContent = new Uint8Array(8 + cttsEntries.length * 8);
        const cttsView = new DataView(cttsContent.buffer);
        cttsView.setUint32(4, cttsEntries.length);
        for (let i = 0; i < cttsEntries.length; i++) {
          cttsView.setUint32(8 + i * 8, cttsEntries[i].count);
          cttsView.setInt32(12 + i * 8, cttsEntries[i].offset);
        }
        ctts = makeBox('ctts', cttsContent);
      }

      // Build stbl
      const stblParts = [stsd, stts, stsc, stsz, stco];
      if (stss) stblParts.push(stss);
      if (ctts) stblParts.push(ctts);
      const stbl = makeBox('stbl', concat(...stblParts));

      const minf = makeBox('minf', concat(mediaHeader, dinf, stbl));
      const mdia = makeBox('mdia', concat(mdhd, hdlr, minf));
      return makeBox('trak', concat(tkhd, mdia));
    }

    // First pass with offset 0 to measure moov size
    let tempTraks = tracks.map(t => buildTrak(t, 0));
    const tempMoov = makeBox('moov', concat(mvhd, ...tempTraks));

    // Calculate real offsets
    const mdatStart = ftyp.length + tempMoov.length + 8;
    let offset = mdatStart;
    const finalTraks = [];

    console.log('BuildMP4: ftyp size:', ftyp.length, 'moov size:', tempMoov.length, 'mdat starts at:', mdatStart);

    for (const track of tracks) {
      console.log(`BuildMP4: Track ${track.type} starts at offset ${offset}`);
      finalTraks.push(buildTrak(track, offset));
      let trackDataSize = 0;
      for (const s of track.samples) {
        if (s.data) {
          trackDataSize += s.data.byteLength;
          offset += s.data.byteLength;
        }
      }
      console.log(`BuildMP4: Track ${track.type} data size: ${trackDataSize}`);
    }

    const moov = makeBox('moov', concat(mvhd, ...finalTraks));
    const mdat = makeBox('mdat', mdatContent);

    console.log('BuildMP4: Final moov size:', moov.length, 'mdat size:', mdat.length, 'total:', ftyp.length + moov.length + mdat.length);

    return concat(ftyp, moov, mdat).buffer;
  }

  // Defragment MP4 - convert fragmented MP4 to regular MP4 by manually building structure
  async function defragmentMP4(fragmentedData, onProgress) {
    return new Promise((resolve, reject) => {
      const file = MP4Box.createFile();
      let fileInfo = null;
      const trackSamples = {}; // track_id -> samples array
      let resolved = false;

      file.onReady = (info) => {
        fileInfo = info;
        console.log('Defrag: Tracks:', info.tracks.map(t => `${t.id}:${t.type}:${t.nb_samples}samples`));

        for (const track of info.tracks) {
          trackSamples[track.id] = [];
          file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
        }
        file.start();
      };

      file.onSamples = (trackId, user, samples) => {
        if (resolved) return;
        console.log(`Defrag: Track ${trackId} got ${samples.length} samples`);
        if (trackSamples[trackId]) {
          trackSamples[trackId].push(...samples);
        }

        let allDone = fileInfo && fileInfo.tracks.every(t =>
          trackSamples[t.id] && trackSamples[t.id].length >= t.nb_samples
        );

        if (allDone && !resolved) {
          resolved = true;
          console.log('Defrag: All samples extracted, building MP4 manually');
          buildManualMP4();
        }
      };

      file.onError = (e) => {
        if (!resolved) {
          resolved = true;
          resolve(fragmentedData);
        }
      };

      function buildManualMP4() {
        try {
          onProgress && onProgress('Building standard MP4...');

          // Collect track data
          const tracks = [];
          for (const track of fileInfo.tracks) {
            const samples = trackSamples[track.id];
            if (!samples || samples.length === 0) continue;

            const srcTrak = file.getTrackById(track.id);
            const stsdEntry = srcTrak?.mdia?.minf?.stbl?.stsd?.entries?.[0];

            tracks.push({
              id: tracks.length + 1,
              type: track.type,
              timescale: track.timescale,
              duration: track.duration,
              width: track.video?.width || track.track_width || 0,
              height: track.video?.height || track.track_height || 0,
              sampleRate: track.audio?.sample_rate || 0,
              channelCount: track.audio?.channel_count || 0,
              codec: track.codec,
              samples: samples,
              stsdEntry: stsdEntry
            });
          }

          console.log('Defrag: Building MP4 with', tracks.length, 'tracks');
          const output = buildMP4File(tracks, fileInfo);
          console.log('Defrag: Built MP4, size:', output.byteLength);

          if (output.byteLength > 10000) {
            resolve(output);
          } else {
            resolve(fragmentedData);
          }
        } catch (e) {
          console.error('Defrag build error:', e);
          resolve(fragmentedData);
        }
      }

      const buf = fragmentedData.slice(0);
      buf.fileStart = 0;
      file.appendBuffer(buf);
      file.flush();

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(fragmentedData);
        }
      }, 15000);
    });
  }

  // Build a complete non-fragmented MP4 file manually
  function buildMP4File(tracks, fileInfo) {
    // Helper to create a box
    function makeBox(type, content) {
      const size = 8 + content.length;
      const box = new Uint8Array(size);
      const view = new DataView(box.buffer);
      view.setUint32(0, size);
      box[4] = type.charCodeAt(0);
      box[5] = type.charCodeAt(1);
      box[6] = type.charCodeAt(2);
      box[7] = type.charCodeAt(3);
      box.set(content, 8);
      return box;
    }

    // Concatenate Uint8Arrays
    function concat(...arrays) {
      const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
      }
      return result;
    }

    // Build ftyp box
    function buildFtyp() {
      const content = new Uint8Array(20);
      const view = new DataView(content.buffer);
      // Major brand: isom
      content[0] = 0x69; content[1] = 0x73; content[2] = 0x6F; content[3] = 0x6D;
      // Minor version
      view.setUint32(4, 0x200);
      // Compatible brands: isom, iso2, avc1, mp41
      content[8] = 0x69; content[9] = 0x73; content[10] = 0x6F; content[11] = 0x6D;
      content[12] = 0x69; content[13] = 0x73; content[14] = 0x6F; content[15] = 0x32;
      content[16] = 0x6D; content[17] = 0x70; content[18] = 0x34; content[19] = 0x31;
      return makeBox('ftyp', content);
    }

    // Build mvhd box
    function buildMvhd(timescale, duration) {
      const content = new Uint8Array(100);
      const view = new DataView(content.buffer);
      // Version 0, flags 0
      view.setUint32(0, 0);
      // Creation/modification time
      view.setUint32(4, 0);
      view.setUint32(8, 0);
      // Timescale
      view.setUint32(12, timescale);
      // Duration
      view.setUint32(16, duration);
      // Rate (1.0 = 0x00010000)
      view.setUint32(20, 0x00010000);
      // Volume (1.0 = 0x0100)
      view.setUint16(24, 0x0100);
      // Reserved (10 bytes)
      // Matrix (36 bytes) - identity matrix
      view.setUint32(36, 0x00010000);
      view.setUint32(52, 0x00010000);
      view.setUint32(68, 0x40000000);
      // Pre-defined (24 bytes at offset 72)
      // Next track ID
      view.setUint32(96, tracks.length + 1);
      return makeBox('mvhd', content);
    }

    // Build tkhd box
    function buildTkhd(track, trackDuration) {
      const content = new Uint8Array(84);
      const view = new DataView(content.buffer);
      // Version 0, flags 3 (enabled, in movie)
      view.setUint32(0, 0x00000003);
      // Creation/modification time
      view.setUint32(4, 0);
      view.setUint32(8, 0);
      // Track ID
      view.setUint32(12, track.id);
      // Reserved
      view.setUint32(16, 0);
      // Duration
      view.setUint32(20, trackDuration);
      // Reserved (8 bytes)
      // Layer, alternate group
      view.setUint16(32, 0);
      view.setUint16(34, 0);
      // Volume (for audio = 0x0100, video = 0)
      view.setUint16(36, track.type === 'audio' ? 0x0100 : 0);
      // Reserved
      view.setUint16(38, 0);
      // Matrix (36 bytes) - identity
      view.setUint32(40, 0x00010000);
      view.setUint32(56, 0x00010000);
      view.setUint32(72, 0x40000000);
      // Width (16.16 fixed point)
      view.setUint32(76, track.width << 16);
      // Height (16.16 fixed point)
      view.setUint32(80, track.height << 16);
      return makeBox('tkhd', content);
    }

    // Build mdhd box
    function buildMdhd(timescale, duration) {
      const content = new Uint8Array(24);
      const view = new DataView(content.buffer);
      view.setUint32(0, 0); // Version/flags
      view.setUint32(4, 0); // Creation time
      view.setUint32(8, 0); // Modification time
      view.setUint32(12, timescale);
      view.setUint32(16, duration);
      view.setUint16(20, 0x55C4); // Language: und
      view.setUint16(22, 0); // Quality
      return makeBox('mdhd', content);
    }

    // Build hdlr box
    function buildHdlr(type) {
      const isVideo = type === 'video';
      const handlerType = isVideo ? 'vide' : 'soun';
      const name = isVideo ? 'VideoHandler' : 'SoundHandler';
      const content = new Uint8Array(25 + name.length);
      const view = new DataView(content.buffer);
      view.setUint32(0, 0); // Version/flags
      view.setUint32(4, 0); // Pre-defined
      content[8] = handlerType.charCodeAt(0);
      content[9] = handlerType.charCodeAt(1);
      content[10] = handlerType.charCodeAt(2);
      content[11] = handlerType.charCodeAt(3);
      // Reserved (12 bytes)
      // Name (null-terminated)
      for (let i = 0; i < name.length; i++) {
        content[24 + i] = name.charCodeAt(i);
      }
      return makeBox('hdlr', content);
    }

    // Build vmhd box (video media header)
    function buildVmhd() {
      const content = new Uint8Array(12);
      const view = new DataView(content.buffer);
      view.setUint32(0, 0x00000001); // Version 0, flags 1
      return makeBox('vmhd', content);
    }

    // Build smhd box (sound media header)
    function buildSmhd() {
      const content = new Uint8Array(8);
      return makeBox('smhd', content);
    }

    // Build dref box
    function buildDref() {
      const urlBox = makeBox('url ', new Uint8Array([0, 0, 0, 1])); // Self-contained
      const content = concat(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), urlBox);
      return makeBox('dref', content);
    }

    // Build dinf box
    function buildDinf() {
      return makeBox('dinf', buildDref());
    }

    // Build stsd box using original entry
    function buildStsd(track) {
      if (track.stsdEntry) {
        // Serialize the original stsd entry
        try {
          const entryData = serializeBox(track.stsdEntry);
          const content = new Uint8Array(8 + entryData.length);
          const view = new DataView(content.buffer);
          view.setUint32(0, 0); // Version/flags
          view.setUint32(4, 1); // Entry count
          content.set(entryData, 8);
          return makeBox('stsd', content);
        } catch (e) {
          console.log('Failed to serialize stsd entry:', e);
        }
      }
      // Fallback: minimal stsd
      const content = new Uint8Array(8);
      const view = new DataView(content.buffer);
      view.setUint32(4, 0); // Entry count 0
      return makeBox('stsd', content);
    }

    // Serialize MP4Box box object to binary
    function serializeBox(box) {
      if (!box) return new Uint8Array(0);

      // Use MP4Box's write method if available
      if (typeof box.write === 'function') {
        const stream = new MP4Box.DataStream();
        stream.endianness = MP4Box.DataStream.BIG_ENDIAN;
        box.write(stream);
        return new Uint8Array(stream.buffer);
      }

      // Manual serialization fallback
      return new Uint8Array(0);
    }

    // Build stts box (time-to-sample)
    function buildStts(samples) {
      // Group consecutive samples with same duration
      const entries = [];
      let currentDuration = samples[0]?.duration || 1;
      let count = 0;

      for (const sample of samples) {
        if (sample.duration === currentDuration) {
          count++;
        } else {
          entries.push({ count, duration: currentDuration });
          currentDuration = sample.duration;
          count = 1;
        }
      }
      if (count > 0) {
        entries.push({ count, duration: currentDuration });
      }

      const content = new Uint8Array(8 + entries.length * 8);
      const view = new DataView(content.buffer);
      view.setUint32(0, 0); // Version/flags
      view.setUint32(4, entries.length);
      for (let i = 0; i < entries.length; i++) {
        view.setUint32(8 + i * 8, entries[i].count);
        view.setUint32(12 + i * 8, entries[i].duration);
      }
      return makeBox('stts', content);
    }

    // Build stss box (sync samples - keyframes)
    function buildStss(samples) {
      const syncSamples = [];
      for (let i = 0; i < samples.length; i++) {
        if (samples[i].is_sync) {
          syncSamples.push(i + 1); // 1-indexed
        }
      }
      if (syncSamples.length === 0 || syncSamples.length === samples.length) {
        return null; // All sync or none - don't include stss
      }
      const content = new Uint8Array(8 + syncSamples.length * 4);
      const view = new DataView(content.buffer);
      view.setUint32(0, 0);
      view.setUint32(4, syncSamples.length);
      for (let i = 0; i < syncSamples.length; i++) {
        view.setUint32(8 + i * 4, syncSamples[i]);
      }
      return makeBox('stss', content);
    }

    // Build stsc box (sample-to-chunk) - all samples in one chunk
    function buildStsc() {
      const content = new Uint8Array(20);
      const view = new DataView(content.buffer);
      view.setUint32(0, 0); // Version/flags
      view.setUint32(4, 1); // Entry count
      view.setUint32(8, 1); // First chunk
      view.setUint32(12, 1); // Samples per chunk (will update later)
      view.setUint32(16, 1); // Sample description index
      return content; // Return raw content, we'll wrap it
    }

    // Build stsz box (sample sizes)
    function buildStsz(samples) {
      const content = new Uint8Array(12 + samples.length * 4);
      const view = new DataView(content.buffer);
      view.setUint32(0, 0); // Version/flags
      view.setUint32(4, 0); // Sample size (0 = variable)
      view.setUint32(8, samples.length);
      for (let i = 0; i < samples.length; i++) {
        view.setUint32(12 + i * 4, samples[i].data?.byteLength || 0);
      }
      return makeBox('stsz', content);
    }

    // Build stco box (chunk offsets) - placeholder, update later
    function buildStco(offset) {
      const content = new Uint8Array(12);
      const view = new DataView(content.buffer);
      view.setUint32(0, 0); // Version/flags
      view.setUint32(4, 1); // Entry count
      view.setUint32(8, offset); // Chunk offset
      return makeBox('stco', content);
    }

    // Build ctts box (composition time offsets) if needed
    function buildCtts(samples) {
      // Check if any sample has cts != dts
      let needsCtts = false;
      for (const sample of samples) {
        if (sample.cts !== sample.dts) {
          needsCtts = true;
          break;
        }
      }
      if (!needsCtts) return null;

      // Group consecutive samples with same offset
      const entries = [];
      let currentOffset = (samples[0]?.cts || 0) - (samples[0]?.dts || 0);
      let count = 0;

      for (const sample of samples) {
        const offset = (sample.cts || 0) - (sample.dts || 0);
        if (offset === currentOffset) {
          count++;
        } else {
          entries.push({ count, offset: currentOffset });
          currentOffset = offset;
          count = 1;
        }
      }
      if (count > 0) {
        entries.push({ count, offset: currentOffset });
      }

      const content = new Uint8Array(8 + entries.length * 8);
      const view = new DataView(content.buffer);
      view.setUint32(0, 0); // Version 0
      view.setUint32(4, entries.length);
      for (let i = 0; i < entries.length; i++) {
        view.setUint32(8 + i * 8, entries[i].count);
        view.setInt32(12 + i * 8, entries[i].offset);
      }
      return makeBox('ctts', content);
    }

    // Build stbl box
    function buildStbl(track, mdatOffset) {
      const stsd = buildStsd(track);
      const stts = buildStts(track.samples);
      const stsz = buildStsz(track.samples);
      const stco = buildStco(mdatOffset);

      // Build stsc - all samples in one chunk
      const stscContent = new Uint8Array(20);
      const stscView = new DataView(stscContent.buffer);
      stscView.setUint32(0, 0);
      stscView.setUint32(4, 1);
      stscView.setUint32(8, 1);
      stscView.setUint32(12, track.samples.length);
      stscView.setUint32(16, 1);
      const stsc = makeBox('stsc', stscContent);

      let parts = [stsd, stts, stsc, stsz, stco];

      // Add stss for video (keyframes)
      if (track.type === 'video') {
        const stss = buildStss(track.samples);
        if (stss) parts.push(stss);
      }

      // Add ctts if needed
      const ctts = buildCtts(track.samples);
      if (ctts) parts.push(ctts);

      return makeBox('stbl', concat(...parts));
    }

    // Build minf box
    function buildMinf(track, mdatOffset) {
      const mediaHeader = track.type === 'video' ? buildVmhd() : buildSmhd();
      const dinf = buildDinf();
      const stbl = buildStbl(track, mdatOffset);
      return makeBox('minf', concat(mediaHeader, dinf, stbl));
    }

    // Build mdia box
    function buildMdia(track, mdatOffset) {
      const mdhd = buildMdhd(track.timescale, track.duration);
      const hdlr = buildHdlr(track.type);
      const minf = buildMinf(track, mdatOffset);
      return makeBox('mdia', concat(mdhd, hdlr, minf));
    }

    // Build trak box
    function buildTrak(track, movieTimescale, mdatOffset) {
      const trackDuration = Math.round(track.duration * movieTimescale / track.timescale);
      const tkhd = buildTkhd(track, trackDuration);
      const mdia = buildMdia(track, mdatOffset);
      return makeBox('trak', concat(tkhd, mdia));
    }

    // Collect all sample data for mdat
    function collectMdatData(tracks) {
      const chunks = [];
      for (const track of tracks) {
        for (const sample of track.samples) {
          if (sample.data) {
            chunks.push(new Uint8Array(sample.data));
          }
        }
      }
      return concat(...chunks);
    }

    // Calculate mdat offset (after ftyp + moov)
    // We need to build moov first to know its size, but moov contains stco which needs mdat offset
    // Solution: build moov with placeholder offset, calculate actual offset, rebuild moov

    const ftyp = buildFtyp();

    // First pass: build moov with placeholder offset to calculate size
    const movieTimescale = 1000;
    let maxDuration = 0;
    for (const track of tracks) {
      const dur = track.duration * movieTimescale / track.timescale;
      if (dur > maxDuration) maxDuration = dur;
    }

    const mvhd = buildMvhd(movieTimescale, Math.round(maxDuration));
    let trakBoxes = [];
    let mdatOffset = 0; // Placeholder

    for (const track of tracks) {
      trakBoxes.push(buildTrak(track, movieTimescale, mdatOffset));
    }

    const moovPlaceholder = makeBox('moov', concat(mvhd, ...trakBoxes));

    // Calculate actual mdat offset
    mdatOffset = ftyp.length + moovPlaceholder.length + 8; // +8 for mdat header

    // Second pass: rebuild moov with correct offset
    // But we need per-track offsets since each track's samples are at different positions

    // Actually, for simplicity, let's interleave all samples into one mdat
    // and have each track point to its portion

    // Collect all media data and calculate offsets per track
    const mdatParts = [];
    const trackOffsets = [];
    let currentOffset = ftyp.length + 8; // Will add moov size later

    // First, calculate total moov size to get mdat start position
    // Build final moov
    trakBoxes = [];
    let sampleDataOffset = 0;
    const allSampleData = [];

    for (const track of tracks) {
      const trackMdatStart = sampleDataOffset;
      for (const sample of track.samples) {
        if (sample.data) {
          allSampleData.push(new Uint8Array(sample.data));
          sampleDataOffset += sample.data.byteLength;
        }
      }
      trackOffsets.push(trackMdatStart);
    }

    // Now rebuild moov with correct offsets
    // We need to recalculate after knowing moov size

    const mdatContent = concat(...allSampleData);
    const mdatSize = 8 + mdatContent.length;

    // Build moov - first calculate its size
    const tempMvhd = buildMvhd(movieTimescale, Math.round(maxDuration));
    let tempTraks = [];

    // Build with temp offset 0 to measure size
    for (let i = 0; i < tracks.length; i++) {
      tempTraks.push(buildTrak(tracks[i], movieTimescale, 0));
    }
    const tempMoov = makeBox('moov', concat(tempMvhd, ...tempTraks));
    const moovSize = tempMoov.length;

    // Real mdat starts after ftyp + moov
    const realMdatStart = ftyp.length + moovSize + 8; // +8 for mdat header

    // Build final traks with correct offsets
    const finalTraks = [];
    let runningOffset = realMdatStart;

    for (let i = 0; i < tracks.length; i++) {
      // This track's data starts at runningOffset
      // But we need to update stco inside the trak
      const trak = buildTrakWithOffset(tracks[i], movieTimescale, runningOffset);
      finalTraks.push(trak);

      // Calculate this track's total data size
      let trackDataSize = 0;
      for (const sample of tracks[i].samples) {
        if (sample.data) {
          trackDataSize += sample.data.byteLength;
        }
      }
      runningOffset += trackDataSize;
    }

    function buildTrakWithOffset(track, movieTimescale, dataOffset) {
      const trackDuration = Math.round(track.duration * movieTimescale / track.timescale);
      const tkhd = buildTkhd(track, trackDuration);

      // Build mdia with correct offset
      const mdhd = buildMdhd(track.timescale, track.duration);
      const hdlr = buildHdlr(track.type);

      // Build minf with correct stco offset
      const mediaHeader = track.type === 'video' ? buildVmhd() : buildSmhd();
      const dinf = buildDinf();

      // Build stbl with correct offset
      const stsd = buildStsd(track);
      const stts = buildStts(track.samples);
      const stsz = buildStsz(track.samples);
      const stco = buildStco(dataOffset); // Correct offset!

      const stscContent = new Uint8Array(20);
      const stscView = new DataView(stscContent.buffer);
      stscView.setUint32(0, 0);
      stscView.setUint32(4, 1);
      stscView.setUint32(8, 1);
      stscView.setUint32(12, track.samples.length);
      stscView.setUint32(16, 1);
      const stsc = makeBox('stsc', stscContent);

      let stblParts = [stsd, stts, stsc, stsz, stco];

      if (track.type === 'video') {
        const stss = buildStss(track.samples);
        if (stss) stblParts.push(stss);
      }

      const ctts = buildCtts(track.samples);
      if (ctts) stblParts.push(ctts);

      const stbl = makeBox('stbl', concat(...stblParts));
      const minf = makeBox('minf', concat(mediaHeader, dinf, stbl));
      const mdia = makeBox('mdia', concat(mdhd, hdlr, minf));

      return makeBox('trak', concat(tkhd, mdia));
    }

    const finalMoov = makeBox('moov', concat(tempMvhd, ...finalTraks));

    // Build mdat
    const mdat = makeBox('mdat', mdatContent);

    // Combine all
    const result = concat(ftyp, finalMoov, mdat);
    console.log('Built non-fragmented MP4:', result.length, 'bytes');

    return result.buffer;
  }

  // Find a sub-box within a box
  function findSubBox(data, targetType) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 8; // Skip the parent box header

    while (offset < data.length - 8) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]
      );

      if (size < 8 || offset + size > data.length) break;

      if (type === targetType) {
        return data.slice(offset, offset + size);
      }

      offset += size;
    }
    return null;
  }

  // Insert audio trak into video moov and update moov size
  function insertTrakIntoMoov(moovData, trakData) {
    // Update the track ID in the audio trak to be track 2
    const trakCopy = new Uint8Array(trakData);
    updateTrackIdInTrak(trakCopy, 2);

    // New moov size = old moov size + trak size
    const newSize = moovData.length + trakCopy.length;
    const newMoov = new Uint8Array(newSize);

    // Copy original moov
    newMoov.set(moovData);

    // Insert trak before the end of moov (after all existing sub-boxes)
    // Actually, we need to insert it properly. Let's just append it.
    newMoov.set(trakCopy, moovData.length);

    // Update moov box size (first 4 bytes)
    const view = new DataView(newMoov.buffer);
    view.setUint32(0, newSize);

    return newMoov;
  }

  // Update track ID in a trak box
  function updateTrackIdInTrak(trakData, newTrackId) {
    // Find tkhd box within trak and update track_ID
    const view = new DataView(trakData.buffer, trakData.byteOffset, trakData.byteLength);
    let offset = 8; // Skip trak header

    while (offset < trakData.length - 8) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        trakData[offset + 4], trakData[offset + 5], trakData[offset + 6], trakData[offset + 7]
      );

      if (size < 8 || offset + size > trakData.length) break;

      if (type === 'tkhd') {
        // tkhd structure: header(8) + version(1) + flags(3) + ...
        // For version 0: track_ID is at offset 12 from box start
        // For version 1: track_ID is at offset 20 from box start
        const version = trakData[offset + 8];
        const trackIdOffset = offset + (version === 0 ? 20 : 28);
        view.setUint32(trackIdOffset, newTrackId);
        console.log('Updated tkhd track_ID to', newTrackId);
        return;
      }

      offset += size;
    }
  }

  // Update track ID in moof box (in tfhd)
  function updateTrackIdInMoof(moofData, newTrackId) {
    const view = new DataView(moofData.buffer, moofData.byteOffset, moofData.byteLength);
    let offset = 8; // Skip moof header

    while (offset < moofData.length - 8) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        moofData[offset + 4], moofData[offset + 5], moofData[offset + 6], moofData[offset + 7]
      );

      if (size < 8 || offset + size > moofData.length) break;

      if (type === 'traf') {
        // Search for tfhd inside traf
        let trafOffset = offset + 8;
        while (trafOffset < offset + size - 8) {
          const subSize = view.getUint32(trafOffset);
          const subType = String.fromCharCode(
            moofData[trafOffset + 4], moofData[trafOffset + 5],
            moofData[trafOffset + 6], moofData[trafOffset + 7]
          );

          if (subSize < 8) break;

          if (subType === 'tfhd') {
            // tfhd: header(8) + version(1) + flags(3) + track_ID(4)
            view.setUint32(trafOffset + 12, newTrackId);
            console.log('Updated tfhd track_ID to', newTrackId);
            return;
          }

          trafOffset += subSize;
        }
      }

      offset += size;
    }
  }

  // Mux video and audio using MP4Box (loaded as content script)
  async function muxVideoAudio(videoData, audioData, onProgress) {
    if (typeof MP4Box === 'undefined') {
      throw new Error('MP4Box library not loaded');
    }

    console.log('Starting mux, video size:', videoData.byteLength, 'audio size:', audioData.byteLength);
    onProgress && onProgress('Parsing streams...');

    // Try direct defragmentation approach - extract stsd from original files
    try {
      onProgress && onProgress('Converting to standard MP4...');
      const result = await defragmentWithRawStsd(videoData, audioData, onProgress);
      if (result && result.byteLength > videoData.byteLength * 0.9) {
        console.log('Direct defragmentation successful, size:', result.byteLength);
        return result;
      }
    } catch (e) {
      console.log('Direct defragmentation failed:', e);
    }

    // Fallback to fragmented MP4
    try {
      const fragmented = await binaryMuxFragmentedMP4(videoData, audioData, onProgress);
      if (fragmented && fragmented.byteLength > videoData.byteLength * 0.9) {
        console.log('Binary mux successful (fragmented), output size:', fragmented.byteLength);
        return fragmented;
      }
    } catch (e) {
      console.log('Binary mux failed:', e);
    }

    // Helper to parse an MP4 file and extract all samples
    function parseFile(data, name) {
      return new Promise((resolve, reject) => {
        const file = MP4Box.createFile();
        let info = null;
        const samples = [];
        let extractionDone = false;
        let totalSamples = 0;

        file.onReady = (fileInfo) => {
          console.log(`${name} parsed:`, fileInfo);
          info = fileInfo;
          if (fileInfo.tracks && fileInfo.tracks.length > 0) {
            const track = fileInfo.tracks[0];
            totalSamples = track.nb_samples || 0;
            console.log(`${name} has ${totalSamples} samples`);
            file.setExtractionOptions(track.id, null, { nbSamples: totalSamples });
            file.start();
          } else {
            resolve({ info: null, samples: [], file: null });
          }
        };

        file.onSamples = (id, user, sampleBatch) => {
          console.log(`${name}: Got ${sampleBatch.length} samples, total now: ${samples.length + sampleBatch.length}`);
          samples.push(...sampleBatch);

          // Check if we have all samples
          if (samples.length >= totalSamples && !extractionDone) {
            extractionDone = true;
            console.log(`${name}: Extraction complete with ${samples.length} samples`);
            resolve({ info, samples, file });
          }
        };

        file.onError = (e) => {
          console.error(`${name} error:`, e);
          reject(e);
        };

        // Append data
        const buf = data.slice(0);
        buf.fileStart = 0;
        file.appendBuffer(buf);
        file.flush();

        // Timeout fallback if onSamples doesn't complete
        setTimeout(() => {
          if (!extractionDone) {
            extractionDone = true;
            console.log(`${name}: Timeout reached with ${samples.length} samples`);
            resolve({ info, samples, file });
          }
        }, 3000);
      });
    }

    try {
      // Parse both files
      onProgress && onProgress('Parsing video...');
      const videoResult = await parseFile(videoData, 'Video');

      onProgress && onProgress('Parsing audio...');
      const audioResult = await parseFile(audioData, 'Audio');

      const videoInfo = videoResult.info;
      const audioInfo = audioResult.info;
      const videoSamples = videoResult.samples;
      const audioSamples = audioResult.samples;

      console.log('Parsed - Video samples:', videoSamples.length, 'Audio samples:', audioSamples.length);

      if (!videoInfo || !videoInfo.tracks || videoInfo.tracks.length === 0) {
        console.log('No valid video info, returning raw data');
        return videoData;
      }

      onProgress && onProgress('Creating combined file...');

      // Create output file
      const outputFile = MP4Box.createFile();
      const vTrack = videoInfo.tracks[0];

      // Get codec configuration from the parsed file
      let videoDesc = null;
      let avcC = null;
      if (videoResult.file) {
        try {
          const trak = videoResult.file.getTrackById(vTrack.id);
          if (trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stsd) {
            const entry = trak.mdia.minf.stbl.stsd.entries[0];
            videoDesc = entry; // Full sample description entry
            if (entry && entry.avcC) {
              avcC = entry.avcC;
              console.log('Found avcC configuration');
            } else if (entry && entry.hvcC) {
              console.log('Found HEVC codec (hvcC)');
            } else if (entry && entry.av1C) {
              console.log('Found AV1 codec (av1C)');
            }
            console.log('Video sample entry type:', entry?.type);
          }
        } catch (e) {
          console.log('Could not extract codec config:', e);
        }
      }

      // Add video track
      let videoTrackId;
      try {
        const width = vTrack.video?.width || vTrack.track_width || 1920;
        const height = vTrack.video?.height || vTrack.track_height || 1080;

        const trackOpts = {
          type: vTrack.type || 'video',
          timescale: vTrack.timescale || 90000,
          duration: vTrack.duration || 0,
          width: width,
          height: height,
          brands: ['isom', 'iso2', 'avc1', 'mp41'],
          avcDecoderConfigRecord: avcC,
          description: videoDesc, // Pass full description
        };

        console.log('Creating video track with:', { type: trackOpts.type, timescale: trackOpts.timescale, width, height, hasAvcC: !!avcC, hasDesc: !!videoDesc });
        videoTrackId = outputFile.addTrack(trackOpts);
        console.log('Added video track:', videoTrackId);
      } catch (e) {
        console.error('Failed to add video track:', e);
        return videoData;
      }

      // Add video samples
      let addedVideoSamples = 0;
      for (const sample of videoSamples) {
        try {
          outputFile.addSample(videoTrackId, sample.data, {
            duration: sample.duration,
            dts: sample.dts,
            cts: sample.cts,
            is_sync: sample.is_sync
          });
          addedVideoSamples++;
        } catch (e) {
          // Continue even if some samples fail
        }
      }
      console.log('Added', addedVideoSamples, 'video samples');

      onProgress && onProgress('Adding audio...');

      // Add audio track if available
      if (audioInfo && audioInfo.tracks && audioInfo.tracks.length > 0 && audioSamples.length > 0) {
        const aTrack = audioInfo.tracks[0];
        console.log('Audio track info:', aTrack);

        // Get audio codec config - need esds for AAC
        let audioDesc = null;
        let esds = null;
        if (audioResult.file) {
          try {
            const audioTrak = audioResult.file.getTrackById(aTrack.id);
            if (audioTrak && audioTrak.mdia && audioTrak.mdia.minf && audioTrak.mdia.minf.stbl && audioTrak.mdia.minf.stbl.stsd) {
              const entry = audioTrak.mdia.minf.stbl.stsd.entries[0];
              audioDesc = entry;
              console.log('Audio sample entry:', entry?.type, 'has esds:', !!entry?.esds);
              if (entry && entry.esds) {
                esds = entry.esds;
              }
            }
          } catch (e) {
            console.log('Could not extract audio codec config:', e);
          }
        }

        try {
          // For AAC audio, we need proper codec configuration
          const sampleRate = aTrack.audio?.sample_rate || 48000;
          const channelCount = aTrack.audio?.channel_count || 2;

          const audioOpts = {
            type: 'audio',
            timescale: aTrack.timescale || sampleRate,
            duration: aTrack.duration || 0,
            media_duration: aTrack.movie_duration || aTrack.duration || 0,
            samplerate: sampleRate,
            channel_count: channelCount,
            samplesize: 16,
            hdlr: 'soun',
            name: 'SoundHandler',
          };

          // If we have the original description with esds, use it
          if (audioDesc) {
            audioOpts.description = audioDesc;
          }

          console.log('Creating audio track with:', {
            timescale: audioOpts.timescale,
            samplerate: sampleRate,
            channels: channelCount,
            hasDesc: !!audioDesc,
            hasEsds: !!esds
          });

          const audioTrackId = outputFile.addTrack(audioOpts);
          console.log('Added audio track:', audioTrackId);

          if (audioTrackId) {
            let addedAudioSamples = 0;
            for (const sample of audioSamples) {
              try {
                outputFile.addSample(audioTrackId, sample.data, {
                  duration: sample.duration,
                  dts: sample.dts,
                  cts: sample.cts,
                  is_sync: sample.is_sync
                });
                addedAudioSamples++;
              } catch (e) {
                if (addedAudioSamples === 0) {
                  console.error('First audio sample failed:', e);
                }
              }
            }
            console.log('Added', addedAudioSamples, 'of', audioSamples.length, 'audio samples');
          } else {
            console.error('Audio track ID is null/undefined');
          }
        } catch (e) {
          console.error('Failed to add audio track:', e);
        }
      } else {
        console.log('No audio to add - audioInfo:', !!audioInfo, 'tracks:', audioInfo?.tracks?.length, 'samples:', audioSamples.length);
      }

      onProgress && onProgress('Finalizing...');

      // Get output
      try {
        const output = outputFile.getBuffer();
        console.log('Output size:', output?.byteLength);

        if (output && output.byteLength > 10000) {
          return output;
        } else {
          console.log('Output too small, using raw video');
          return videoData;
        }
      } catch (e) {
        console.error('getBuffer failed:', e);
        return videoData;
      }

    } catch (error) {
      console.error('Mux error:', error);
      return videoData; // Fallback to video only
    }
  }

  // Extract app ID from URL
  function getAppId() {
    const match = window.location.pathname.match(/\/app\/(\d+)/);
    return match ? match[1] : null;
  }

  // Parse DASH MPD manifest
  async function parseMPD(mpdUrl) {
    const response = await fetch(mpdUrl);
    const text = await response.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');

    const baseUrl = mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1);
    const representations = [];

    // Get video representations
    xml.querySelectorAll('AdaptationSet[contentType="video"] Representation').forEach(rep => {
      const segTemplate = rep.querySelector('SegmentTemplate');
      if (segTemplate) {
        const init = segTemplate.getAttribute('initialization').replace('$RepresentationID$', rep.getAttribute('id'));
        const media = segTemplate.getAttribute('media');
        const duration = parseInt(segTemplate.getAttribute('duration')) / parseInt(segTemplate.getAttribute('timescale') || 1000000);

        representations.push({
          id: rep.getAttribute('id'),
          type: 'video',
          width: parseInt(rep.getAttribute('width')),
          height: parseInt(rep.getAttribute('height')),
          bandwidth: parseInt(rep.getAttribute('bandwidth')),
          codec: rep.getAttribute('codecs'),
          init: baseUrl + init,
          mediaTemplate: baseUrl + media,
          segmentDuration: duration
        });
      }
    });

    // Get audio representations
    xml.querySelectorAll('AdaptationSet[contentType="audio"] Representation').forEach(rep => {
      const segTemplate = rep.querySelector('SegmentTemplate');
      if (segTemplate) {
        const init = segTemplate.getAttribute('initialization').replace('$RepresentationID$', rep.getAttribute('id'));
        const media = segTemplate.getAttribute('media');
        const duration = parseInt(segTemplate.getAttribute('duration')) / parseInt(segTemplate.getAttribute('timescale') || 1000000);

        representations.push({
          id: rep.getAttribute('id'),
          type: 'audio',
          bandwidth: parseInt(rep.getAttribute('bandwidth')),
          codec: rep.getAttribute('codecs'),
          init: baseUrl + init,
          mediaTemplate: baseUrl + media,
          segmentDuration: duration
        });
      }
    });

    // Get total duration
    const durationAttr = xml.querySelector('MPD').getAttribute('mediaPresentationDuration');
    let totalDuration = 60;
    if (durationAttr) {
      const match = durationAttr.match(/PT(\d+\.?\d*)S/);
      if (match) totalDuration = parseFloat(match[1]);
    }

    return { representations, totalDuration, baseUrl };
  }

  // Download all segments for a representation
  async function downloadSegments(rep, totalDuration, onProgress) {
    const chunks = [];

    // Download init segment
    const initResponse = await fetch(rep.init);
    chunks.push(await initResponse.arrayBuffer());

    // Calculate number of segments
    const numSegments = Math.ceil(totalDuration / rep.segmentDuration);

    // Download each segment
    for (let i = 1; i <= numSegments; i++) {
      const segUrl = rep.mediaTemplate
        .replace('$RepresentationID$', rep.id)
        .replace('$Number%05d$', String(i).padStart(5, '0'));

      try {
        const response = await fetch(segUrl);
        if (response.ok) {
          chunks.push(await response.arrayBuffer());
          onProgress((i / numSegments) * 100);
        }
      } catch (e) {
        console.log(`Segment ${i} failed, stopping`);
        break;
      }
    }

    return chunks;
  }

  // Concatenate ArrayBuffers
  function concatenateBuffers(buffers) {
    const totalLength = buffers.reduce((acc, buf) => acc + buf.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buffer of buffers) {
      result.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }
    return result.buffer;
  }

  // Find DASH MPD URLs from page
  function findDashUrls() {
    const dashUrls = [];
    const appId = getAppId();
    if (!appId) {
      console.log('Steam Video Downloader: No app ID found');
      return dashUrls;
    }
    console.log('Steam Video Downloader: Looking for videos, appId:', appId);

    // Method 1: Search all script tags for trailer URLs
    document.querySelectorAll('script').forEach(script => {
      const text = script.textContent || '';

      // Pattern for DASH manifest URLs
      const trailerMatches = text.matchAll(/store_trailers\/(\d+)\/(\d+)\/([a-f0-9]+)\/(\d+)/g);
      for (const match of trailerMatches) {
        const [, appMatch, movieId, hash, version] = match;
        const mpdUrl = `https://video.fastly.steamstatic.com/store_trailers/${appMatch}/${movieId}/${hash}/${version}/dash_av1.mpd`;
        if (!dashUrls.find(d => d.url === mpdUrl)) {
          dashUrls.push({
            url: mpdUrl,
            movieId,
            name: `Trailer`
          });
        }
      }
    });

    // Method 2: Look for video elements with data attributes
    document.querySelectorAll('[data-webm-source], [data-mp4-source], [data-dash-source]').forEach(el => {
      const dashSrc = el.getAttribute('data-dash-source');
      if (dashSrc && !dashUrls.find(d => d.url === dashSrc)) {
        dashUrls.push({
          url: dashSrc,
          movieId: 'unknown',
          name: 'Trailer'
        });
      }
    });

    // Method 3: Search for rgMovieFlashvars (Steam's movie data)
    const pageHtml = document.documentElement.innerHTML;
    const flashvarsMatch = pageHtml.match(/rgMovieFlashvars\s*=\s*(\{[^;]+\});/);
    if (flashvarsMatch) {
      try {
        const movieData = JSON.parse(flashvarsMatch[1]);
        Object.values(movieData).forEach((movie) => {
          if (movie.DASH_AV1_SOURCE) {
            const url = movie.DASH_AV1_SOURCE;
            if (!dashUrls.find(d => d.url === url)) {
              dashUrls.push({
                url,
                movieId: movie.MOVIE_ID || 'unknown',
                name: movie.FILENAME?.replace(/\.[^.]+$/, '') || 'Trailer'
              });
            }
          } else if (movie.WEBM_SOURCE) {
            // Fallback to direct WEBM if no DASH
            if (!dashUrls.find(d => d.url === movie.WEBM_SOURCE)) {
              dashUrls.push({
                url: movie.WEBM_SOURCE,
                movieId: movie.MOVIE_ID || 'unknown',
                name: movie.FILENAME?.replace(/\.[^.]+$/, '') || 'Trailer',
                isDirect: true
              });
            }
          }
        });
      } catch (e) {
        console.log('Steam Video Downloader: Failed to parse rgMovieFlashvars', e);
      }
    }

    // Method 4: Look for highlight_movie elements
    document.querySelectorAll('.highlight_movie').forEach(el => {
      const movieId = el.getAttribute('data-movie-id') || el.id?.replace('highlight_movie_', '');
      if (movieId) {
        // Try to find the movie URL in page scripts
        const urlMatch = pageHtml.match(new RegExp(`"MOVIE_ID"\\s*:\\s*"?${movieId}"?[^}]*"DASH_AV1_SOURCE"\\s*:\\s*"([^"]+)"`));
        if (urlMatch && !dashUrls.find(d => d.url === urlMatch[1])) {
          dashUrls.push({
            url: urlMatch[1],
            movieId,
            name: 'Trailer'
          });
        }
      }
    });

    // Method 5: Search for DASH manifest URLs in escaped JSON (Steam uses \/ escaping)
    // Prefer H264 over AV1 for better compatibility
    // Pattern matches URLs like: https:\/\/video.fastly.steamstatic.com\/store_trailers\/...\/dash_h264.mpd
    const h264MpdMatches = pageHtml.matchAll(/https?:\\?\/\\?\/video\.(?:fastly|akamai)\.steamstatic\.com\\?\/store_trailers\\?\/\d+\\?\/\d+\\?\/[a-f0-9]+\\?\/\d+\\?\/dash_h264\.mpd(?:\?[^"'\\]*)*/gi);
    for (const match of h264MpdMatches) {
      let url = match[0].replace(/\\\//g, '/').replace(/\\u002F/g, '/');
      const baseUrl = url.split('?')[0];
      if (!dashUrls.find(d => d.url === baseUrl || d.url === url)) {
        const titleMatch = pageHtml.substring(Math.max(0, match.index - 200), match.index).match(/"title"\s*:\s*"([^"]+)"/);
        dashUrls.push({
          url: baseUrl,
          movieId: 'trailer',
          name: titleMatch ? titleMatch[1] : 'Trailer'
        });
      }
    }

    // Fallback to AV1 if no H264 found
    if (dashUrls.length === 0) {
      const av1MpdMatches = pageHtml.matchAll(/https?:\\?\/\\?\/video\.(?:fastly|akamai)\.steamstatic\.com\\?\/store_trailers\\?\/\d+\\?\/\d+\\?\/[a-f0-9]+\\?\/\d+\\?\/dash_av1\.mpd(?:\?[^"'\\]*)*/gi);
      for (const match of av1MpdMatches) {
        let url = match[0].replace(/\\\//g, '/').replace(/\\u002F/g, '/');
        const baseUrl = url.split('?')[0];
        if (!dashUrls.find(d => d.url === baseUrl || d.url === url)) {
          const titleMatch = pageHtml.substring(Math.max(0, match.index - 200), match.index).match(/"title"\s*:\s*"([^"]+)"/);
          dashUrls.push({
            url: baseUrl,
            movieId: 'trailer',
            name: titleMatch ? titleMatch[1] : 'Trailer'
          });
        }
      }
    }

    // Method 6: Search for steamstatic video URLs
    const videoUrlMatches = pageHtml.matchAll(/https?:\/\/[^"'\s]*(?:steamstatic|akamai)[^"'\s]*(?:movie|video|trailer)[^"'\s]*\.(?:mp4|webm|mpd)/gi);
    for (const match of videoUrlMatches) {
      let url = match[0];
      // Clean up escaped characters
      url = url.replace(/\\u002F/g, '/').replace(/\\/g, '');
      if (!dashUrls.find(d => d.url === url)) {
        const isDirect = !url.endsWith('.mpd');
        dashUrls.push({
          url,
          movieId: 'unknown',
          name: 'Video',
          isDirect
        });
      }
    }

    // Method 7: Look for video source in highlight player (skip blob URLs)
    document.querySelectorAll('video source, video[src]').forEach(el => {
      const src = el.src || el.getAttribute('src');
      // Skip blob URLs - they can't be downloaded directly
      if (src && src.includes('steam') && !src.startsWith('blob:') && !dashUrls.find(d => d.url === src)) {
        dashUrls.push({
          url: src,
          movieId: 'unknown',
          name: 'Video',
          isDirect: true
        });
      }
    });

    // Method 8: Look for DASH manifest in rgCommonAppsData or similar structures
    const dashManifestMatches = pageHtml.matchAll(/dash(?:_av1)?\.mpd[^"']*/gi);
    for (const match of dashManifestMatches) {
      console.log('Steam Video Downloader: Found MPD reference:', match[0]);
    }

    // Method 9: Search for video.fastly.steamstatic.com or video.akamai URLs
    const fastlyMatches = pageHtml.matchAll(/https?:\/\/video\.(?:fastly|akamai)\.steamstatic\.com\/[^"'\s<>]+/gi);
    for (const match of fastlyMatches) {
      let url = match[0].replace(/\\u002F/g, '/').replace(/\\/g, '');
      if (url.endsWith('.mpd') && !dashUrls.find(d => d.url === url)) {
        dashUrls.push({
          url,
          movieId: 'unknown',
          name: 'Trailer'
        });
      }
    }

    // Method 10: Look for movie configuration in data attributes
    document.querySelectorAll('[data-publishedfileid], [data-movie], .highlight_movie').forEach(el => {
      const movieId = el.getAttribute('data-movie-id') || el.getAttribute('data-publishedfileid');
      console.log('Steam Video Downloader: Found movie element:', el.className, movieId);
    });

    // Method 11: Search all scripts for store_trailers pattern (the MPD path)
    const allScripts = document.querySelectorAll('script');
    allScripts.forEach(script => {
      const text = script.textContent || '';
      // Look for trailer URL components
      const storeTrailerMatch = text.match(/store_trailers[\\\/]+(\d+)[\\\/]+(\d+)[\\\/]+([a-f0-9]+)[\\\/]+(\d+)/i);
      if (storeTrailerMatch) {
        const [, appMatch, movieId, hash, version] = storeTrailerMatch;
        const mpdUrl = `https://video.fastly.steamstatic.com/store_trailers/${appMatch}/${movieId}/${hash}/${version}/dash_av1.mpd`;
        console.log('Steam Video Downloader: Found trailer from script:', mpdUrl);
        if (!dashUrls.find(d => d.url === mpdUrl)) {
          dashUrls.push({
            url: mpdUrl,
            movieId,
            name: 'Trailer'
          });
        }
      }
    });

    // Debug: Log some page content to see what we're working with
    if (dashUrls.length === 0) {
      console.log('Steam Video Downloader: No trailer videos found. Searching for clues...');
      const movieMatches = pageHtml.match(/movie|video|trailer|\.mp4|\.webm|\.mpd/gi);
      console.log('Steam Video Downloader: Video-related terms found:', movieMatches?.length || 0);

      // Log any URLs that contain video-related paths
      const anyVideoUrl = pageHtml.match(/https?:\/\/[^"'\s<>]+(?:movie|video|trailer)[^"'\s<>]*/gi);
      console.log('Steam Video Downloader: Potential video URLs:', anyVideoUrl?.slice(0, 5));

      // Search for any store_trailers references
      const trailerRefs = pageHtml.match(/store_trailers[^"'\s<>]*/gi);
      console.log('Steam Video Downloader: store_trailers references:', trailerRefs?.slice(0, 5));
    }

    console.log('Steam Video Downloader: Found videos:', dashUrls.length, dashUrls);
    return dashUrls;
  }

  // Find extra videos (direct downloads)
  function findExtras() {
    const extrasMap = new Map(); // Group by video name
    const appId = getAppId();
    if (!appId) return [];

    const appDataEl = document.querySelector('[data-appassets]');
    if (appDataEl) {
      try {
        let appAssets = appDataEl.getAttribute('data-appassets');
        appAssets = appAssets.replace(/&quot;/g, '"');
        const data = JSON.parse(appAssets);

        Object.entries(data).forEach(([key, variants]) => {
          if (Array.isArray(variants)) {
            const mp4 = variants.find(v => v.extension === 'mp4');
            const webm = variants.find(v => v.extension === 'webm');

            // Get base name without extension
            const baseName = key.replace('extras/', '').replace(/\.[^.]+$/, '');

            if (!extrasMap.has(baseName)) {
              extrasMap.set(baseName, { name: baseName, formats: {} });
            }

            const entry = extrasMap.get(baseName);

            if (mp4) {
              const url = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/${mp4.urlPart}`;
              entry.formats.mp4 = url;
            }
            if (webm) {
              const url = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/${webm.urlPart}`;
              entry.formats.webm = url;
            }
          }
        });
      } catch (e) {
        console.log('Steam Video Downloader: Could not parse app assets', e);
      }
    }

    // Convert map to array
    return Array.from(extrasMap.values());
  }

  // Download DASH video with automatic muxing
  async function downloadDashVideo(mpdUrl, filename) {
    if (isDownloading) {
      alert('A download is already in progress');
      return;
    }

    isDownloading = true;
    showProgressPopup();

    try {
      updateProgress('Parsing video manifest...', 0);
      const { representations, totalDuration } = await parseMPD(mpdUrl);

      // Get best quality streams
      const videos = representations.filter(r => r.type === 'video').sort((a, b) => b.height - a.height);
      const audios = representations.filter(r => r.type === 'audio').sort((a, b) => b.bandwidth - a.bandwidth);

      console.log('Found representations - videos:', videos.length, 'audios:', audios.length);
      console.log('All representations:', representations);

      if (videos.length === 0) {
        throw new Error('No video streams found');
      }

      const bestVideo = videos[0];
      const bestAudio = audios[0];

      console.log('Best video:', bestVideo?.width + 'x' + bestVideo?.height, bestVideo?.codec);
      console.log('Best audio:', bestAudio?.bandwidth, bestAudio?.codec);

      updateProgress(`Downloading video (${bestVideo.width}x${bestVideo.height})...`, 2);

      // Download video segments
      const videoChunks = await downloadSegments(bestVideo, totalDuration, (p) => {
        updateProgress(`Downloading video... ${Math.round(p)}%`, 2 + (p * 0.40));
      });

      const videoData = concatenateBuffers(videoChunks);

      if (bestAudio) {
        updateProgress('Downloading audio...', 45);

        // Download audio segments
        const audioChunks = await downloadSegments(bestAudio, totalDuration, (p) => {
          updateProgress(`Downloading audio... ${Math.round(p)}%`, 45 + (p * 0.40));
        });

        const audioData = concatenateBuffers(audioChunks);
        console.log('Downloaded - video size:', videoData.byteLength, 'audio size:', audioData.byteLength);

        updateProgress('Combining video & audio...', 88);

        // Try to mux video and audio
        try {
          const muxedData = await muxVideoAudio(videoData, audioData, (status) => {
            updateProgress(status, 90);
          });

          updateProgress('Complete!', 100);

          // Download the muxed file
          downloadBlob(new Blob([muxedData], { type: 'video/mp4' }), filename);

          setTimeout(() => {
            hideProgressPopup();
            isDownloading = false;
          }, 1500);

        } catch (muxError) {
          console.error('Muxing failed:', muxError);
          updateProgress('Muxing failed, downloading separately...', 95);

          // Fallback: download separately
          downloadBlob(new Blob([videoData], { type: 'video/mp4' }), filename.replace('.mp4', '_video.mp4'));
          await new Promise(r => setTimeout(r, 500));
          downloadBlob(new Blob([audioData], { type: 'audio/mp4' }), filename.replace('.mp4', '_audio.m4a'));

          setTimeout(() => {
            hideProgressPopup();
            isDownloading = false;
          }, 2000);
        }

      } else {
        updateProgress('Creating video file...', 95);
        downloadBlob(new Blob([videoData], { type: 'video/mp4' }), filename);
        updateProgress('Complete!', 100);

        setTimeout(() => {
          hideProgressPopup();
          isDownloading = false;
        }, 1500);
      }

    } catch (error) {
      console.error('Download failed:', error);
      updateProgress(`Error: ${error.message}`, 0);
      setTimeout(() => {
        hideProgressPopup();
        isDownloading = false;
        currentDownloadResolve = null;
        currentDownloadReject = null;
      }, 3000);
    }
  }

  // Download blob as file
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Progress popup functions
  function showProgressPopup() {
    let popup = document.getElementById('svd-progress');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'svd-progress';
      popup.innerHTML = `
        <div class="svd-progress-title">Steam Video Downloader</div>
        <div class="svd-progress-text">Preparing download...</div>
        <div class="svd-progress-bar"><div class="svd-progress-fill"></div></div>
        <div class="svd-progress-hint">This may take a minute for longer videos</div>
        <button class="svd-cancel-btn" id="svd-cancel">Cancel</button>
      `;
      document.body.appendChild(popup);

      // Cancel button handler
      popup.querySelector('#svd-cancel').addEventListener('click', () => {
        isDownloading = false;
        currentDownloadResolve = null;
        currentDownloadReject = null;
        hideProgressPopup();
      });
    }
    popup.style.display = 'block';
  }

  function updateProgress(text, percent) {
    const popup = document.getElementById('svd-progress');
    if (popup) {
      popup.querySelector('.svd-progress-text').textContent = text;
      popup.querySelector('.svd-progress-fill').style.width = `${percent}%`;
    }
  }

  function hideProgressPopup() {
    const popup = document.getElementById('svd-progress');
    if (popup) popup.style.display = 'none';
  }

  // Create download icon SVG
  function createDownloadIcon() {
    return `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
    </svg>`;
  }

  // Show download popup
  function showDownloadPopup() {
    const existing = document.getElementById('svd-popup');
    if (existing) {
      existing.remove();
      return;
    }

    const dashUrls = findDashUrls();
    const extras = findExtras();
    const appId = getAppId();
    const gameName = document.querySelector('.apphub_AppName')?.textContent?.trim() || `Steam_${appId}`;

    // Separate DASH streams from direct video URLs
    const dashStreams = dashUrls.filter(d => !d.isDirect);
    const directVideos = dashUrls.filter(d => d.isDirect);

    // Group direct videos by base URL (strip extension)
    const directGrouped = new Map();
    directVideos.forEach(vid => {
      // Get base URL without extension
      const baseUrl = vid.url.replace(/\.(mp4|webm)(\?.*)?$/i, '');
      const ext = vid.url.match(/\.(mp4|webm)/i)?.[1]?.toLowerCase() || 'mp4';

      if (!directGrouped.has(baseUrl)) {
        directGrouped.set(baseUrl, { name: vid.name, formats: {} });
      }
      directGrouped.get(baseUrl).formats[ext] = vid.url;
    });
    const groupedDirectVideos = Array.from(directGrouped.values());

    if (dashStreams.length === 0 && groupedDirectVideos.length === 0 && extras.length === 0) {
      alert('No downloadable videos found on this page.');
      return;
    }

    const popup = document.createElement('div');
    popup.id = 'svd-popup';

    let html = `
      <div class="svd-header">
        <span>Download Steam Videos</span>
        <button class="svd-close">&times;</button>
      </div>
      <div class="svd-content">
    `;

    // DASH Trailers (require muxing)
    if (dashStreams.length > 0) {
      html += `<div class="svd-section-title">Trailers</div>`;
      dashStreams.forEach((dash, i) => {
        const filename = `${gameName.replace(/[^a-zA-Z0-9]/g, '_')}_trailer${dashStreams.length > 1 ? '_' + (i + 1) : ''}.mp4`;
        html += `
          <div class="svd-item">
            <span class="svd-name">${dash.name}${dashStreams.length > 1 ? ' ' + (i + 1) : ''}</span>
            <div class="svd-buttons">
              <button class="svd-btn svd-btn-download" data-url="${dash.url}" data-filename="${filename}" data-direct="false">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="margin-right:6px">
                  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                </svg>
                Download MP4
              </button>
            </div>
          </div>
        `;
      });
    }

    // Direct videos (grouped by format)
    if (groupedDirectVideos.length > 0) {
      html += `<div class="svd-section-title">Videos</div>`;
      groupedDirectVideos.forEach((vid, i) => {
        const hasMultiple = vid.formats.mp4 && vid.formats.webm;
        const baseName = `${gameName.replace(/[^a-zA-Z0-9]/g, '_')}_video_${i + 1}`;
        html += `
          <div class="svd-item">
            <span class="svd-name">Video ${i + 1}</span>
            <div class="svd-buttons">
              ${hasMultiple ? `
                <div class="svd-split-btn">
                  <button class="svd-btn svd-btn-split svd-btn-mp4 svd-btn-direct" data-url="${vid.formats.mp4}" data-filename="${baseName}.mp4">MP4</button>
                  <button class="svd-btn svd-btn-split svd-btn-webm svd-btn-direct" data-url="${vid.formats.webm}" data-filename="${baseName}.webm">WEBM</button>
                </div>
              ` : `
                <button class="svd-btn svd-btn-small svd-btn-direct" data-url="${vid.formats.mp4 || vid.formats.webm}" data-filename="${baseName}.${vid.formats.mp4 ? 'mp4' : 'webm'}">${vid.formats.mp4 ? 'MP4' : 'WEBM'}</button>
              `}
            </div>
          </div>
        `;
      });
    }

    // Extra clips from data-appassets
    if (extras.length > 0) {
      html += `<div class="svd-section-title">Extra Clips</div>`;
      extras.forEach((extra, i) => {
        const hasMultiple = extra.formats.mp4 && extra.formats.webm;
        const baseName = `${gameName.replace(/[^a-zA-Z0-9]/g, '_')}_clip_${i + 1}`;
        html += `
          <div class="svd-item">
            <span class="svd-name">Clip ${i + 1}</span>
            <div class="svd-buttons">
              ${hasMultiple ? `
                <div class="svd-split-btn">
                  <button class="svd-btn svd-btn-split svd-btn-mp4 svd-btn-direct" data-url="${extra.formats.mp4}" data-filename="${baseName}.mp4">MP4</button>
                  <button class="svd-btn svd-btn-split svd-btn-webm svd-btn-direct" data-url="${extra.formats.webm}" data-filename="${baseName}.webm">WEBM</button>
                </div>
              ` : `
                <button class="svd-btn svd-btn-small svd-btn-direct" data-url="${extra.formats.mp4 || extra.formats.webm}" data-filename="${baseName}.${extra.formats.mp4 ? 'mp4' : 'webm'}">${extra.formats.mp4 ? 'MP4' : 'WEBM'}</button>
              `}
            </div>
          </div>
        `;
      });
    }

    html += `</div>`;
    popup.innerHTML = html;
    document.body.appendChild(popup);

    // Event handlers
    popup.querySelector('.svd-close').addEventListener('click', () => popup.remove());

    popup.querySelectorAll('.svd-btn-download').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = btn.getAttribute('data-url');
        const filename = btn.getAttribute('data-filename');
        popup.remove();
        downloadDashVideo(url, filename);
      });
    });

    // Direct video download buttons (MP4/WEBM)
    popup.querySelectorAll('.svd-btn-direct').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = btn.getAttribute('data-url');
        const filename = btn.getAttribute('data-filename');
        popup.remove();

        try {
          showProgressPopup();
          updateProgress('Downloading video...', 10);
          const response = await fetch(url);
          const total = parseInt(response.headers.get('content-length') || '0');
          const reader = response.body.getReader();
          const chunks = [];
          let received = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (total > 0) {
              updateProgress('Downloading...', Math.round((received / total) * 90));
            }
          }

          const blob = new Blob(chunks);
          updateProgress('Complete!', 100);
          downloadBlob(blob, filename);
          setTimeout(hideProgressPopup, 1500);
        } catch (error) {
          console.error('Direct download failed:', error);
          updateProgress('Error: ' + error.message, 0);
          setTimeout(hideProgressPopup, 3000);
        }
      });
    });

    // Close on outside click
    setTimeout(() => {
      const closeHandler = (e) => {
        if (!popup.contains(e.target) && !e.target.closest('.steam-dl-btn') && !e.target.closest('#svd-float-btn')) {
          popup.remove();
          document.removeEventListener('click', closeHandler);
        }
      };
      document.addEventListener('click', closeHandler);
    }, 100);
  }

  // Inject button into player controls
  function injectPlayerButton() {
    const fullscreenBtn = document.querySelector('.fullscreen_button:not([' + PROCESSED_ATTR + '])');
    if (fullscreenBtn) {
      fullscreenBtn.setAttribute(PROCESSED_ATTR, 'true');

      const downloadBtn = document.createElement('div');
      downloadBtn.className = 'steam-dl-btn';
      downloadBtn.title = 'Download Video';
      downloadBtn.innerHTML = createDownloadIcon();

      downloadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showDownloadPopup();
      });

      fullscreenBtn.parentNode.insertBefore(downloadBtn, fullscreenBtn);
      console.log('Steam Video Downloader: Button injected into player');
      return true;
    }
    return false;
  }

  // Add floating button
  function addFloatingButton() {
    if (document.getElementById('svd-float-btn')) return;

    const btn = document.createElement('div');
    btn.id = 'svd-float-btn';
    btn.title = 'Download Steam Videos';
    btn.innerHTML = createDownloadIcon();
    btn.addEventListener('click', showDownloadPopup);
    document.body.appendChild(btn);
  }

  // Add styles
  function addStyles() {
    if (document.getElementById('svd-styles')) return;

    const style = document.createElement('style');
    style.id = 'svd-styles';
    style.textContent = `
      #svd-float-btn {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 56px;
        height: 56px;
        background: linear-gradient(135deg, #1a9fff 0%, #0066cc 100%);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 4px 20px rgba(26, 159, 255, 0.5);
        z-index: 999999;
        transition: transform 0.2s, box-shadow 0.2s;
        color: white;
      }
      #svd-float-btn:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 25px rgba(26, 159, 255, 0.7);
      }
      #svd-float-btn svg { width: 26px; height: 26px; }

      .steam-dl-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        margin-right: 10px;
        color: #67c1f5;
        padding: 6px;
        border-radius: 4px;
        transition: all 0.2s;
      }
      .steam-dl-btn:hover {
        color: #ffffff;
        background: rgba(103, 193, 245, 0.3);
      }
      .steam-dl-btn svg { width: 22px; height: 22px; }

      #svd-popup {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: #1b2838;
        border-radius: 12px;
        box-shadow: 0 15px 50px rgba(0, 0, 0, 0.7);
        z-index: 1000000;
        min-width: 380px;
        max-width: 500px;
        font-family: "Motiva Sans", Arial, sans-serif;
        color: #c6d4df;
        border: 1px solid #2a475e;
        overflow: hidden;
      }
      .svd-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 18px 22px;
        background: linear-gradient(135deg, #171d25 0%, #1b2838 100%);
        border-bottom: 1px solid #2a475e;
      }
      .svd-header span {
        font-size: 17px;
        font-weight: 600;
        color: #fff;
        text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      }
      .svd-close {
        background: none;
        border: none;
        color: #8f98a0;
        font-size: 26px;
        cursor: pointer;
        line-height: 1;
        padding: 0;
        transition: color 0.2s;
      }
      .svd-close:hover { color: #fff; }
      .svd-content {
        padding: 18px;
        max-height: 400px;
        overflow-y: auto;
      }
      .svd-section-title {
        font-size: 11px;
        font-weight: 700;
        color: #67c1f5;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid #2a475e;
      }
      .svd-section-title:not(:first-child) { margin-top: 20px; }
      .svd-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 14px;
        background: linear-gradient(135deg, #16202d 0%, #1a2634 100%);
        border-radius: 6px;
        margin-bottom: 10px;
        border: 1px solid rgba(42, 71, 94, 0.5);
      }
      .svd-item:last-child { margin-bottom: 0; }
      .svd-item:hover { border-color: rgba(103, 193, 245, 0.3); }
      .svd-name {
        font-size: 14px;
        color: #c6d4df;
        flex: 1;
        min-width: 100px;
      }
      .svd-buttons { display: flex; gap: 8px; }
      .svd-btn {
        display: inline-flex;
        align-items: center;
        background: linear-gradient(135deg, #1a9fff 0%, #0066cc 100%);
        border: none;
        color: white;
        padding: 10px 18px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        text-decoration: none;
        transition: all 0.2s;
        box-shadow: 0 2px 8px rgba(26, 159, 255, 0.3);
      }
      .svd-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(26, 159, 255, 0.5);
        color: white;
        text-decoration: none;
      }
      .svd-btn-small {
        padding: 8px 14px;
        font-size: 12px;
      }

      .svd-split-btn {
        display: flex;
        border-radius: 6px;
        overflow: hidden;
      }

      .svd-btn-split {
        padding: 8px 14px;
        font-size: 12px;
        border-radius: 0;
        text-decoration: none;
      }

      .svd-btn-split:first-child {
        border-radius: 6px 0 0 6px;
        border-right: 1px solid rgba(255,255,255,0.2);
      }

      .svd-btn-split:last-child {
        border-radius: 0 6px 6px 0;
      }

      .svd-btn-mp4 {
        background: linear-gradient(135deg, #4CAF50 0%, #2E7D32 100%);
      }

      .svd-btn-mp4:hover {
        background: linear-gradient(135deg, #66BB6A 0%, #388E3C 100%);
      }

      .svd-btn-webm {
        background: linear-gradient(135deg, #9C27B0 0%, #6A1B9A 100%);
      }

      .svd-btn-webm:hover {
        background: linear-gradient(135deg, #AB47BC 0%, #7B1FA2 100%);
      }

      #svd-progress {
        position: fixed;
        bottom: 90px;
        right: 20px;
        background: linear-gradient(135deg, #1b2838 0%, #171d25 100%);
        border: 1px solid #2a475e;
        border-radius: 12px;
        padding: 18px 22px;
        min-width: 300px;
        z-index: 1000001;
        font-family: "Motiva Sans", Arial, sans-serif;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
      }
      .svd-progress-title {
        color: #67c1f5;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 10px;
      }
      .svd-progress-text {
        color: #ffffff;
        font-size: 14px;
        margin-bottom: 12px;
        font-weight: 500;
      }
      .svd-progress-bar {
        height: 8px;
        background: #16202d;
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 10px;
      }
      .svd-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #1a9fff 0%, #67c1f5 50%, #1a9fff 100%);
        background-size: 200% 100%;
        border-radius: 4px;
        width: 0%;
        transition: width 0.3s ease;
        animation: svd-shimmer 2s linear infinite;
      }
      @keyframes svd-shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      .svd-progress-hint {
        color: #8f98a0;
        font-size: 11px;
      }
      .svd-cancel-btn {
        margin-top: 12px;
        padding: 8px 16px;
        background: #2a475e;
        border: 1px solid #3d6c8e;
        color: #c6d4df;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
      }
      .svd-cancel-btn:hover {
        background: #3d6c8e;
        color: #fff;
      }
    `;
    document.head.appendChild(style);
  }

  // Watch for player
  function watchForPlayer() {
    const observer = new MutationObserver(() => injectPlayerButton());
    observer.observe(document.body, { childList: true, subtree: true });

    injectPlayerButton();
    setTimeout(injectPlayerButton, 1000);
    setTimeout(injectPlayerButton, 2000);
    setTimeout(injectPlayerButton, 3000);
  }

  // Initialize
  function init() {
    console.log('Steam Video Downloader: Initializing...');
    addStyles();
    addFloatingButton();
    watchForPlayer();
    console.log('Steam Video Downloader: Ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
