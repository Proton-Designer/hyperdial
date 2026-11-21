/**
 * TASK-H34: turn whatever MediaRecorder produced (webm/opus on Chrome and Firefox, mp4/aac on Safari) into a small
 * 16-bit mono WAV, the format the voicemail-upload function and Telnyx playback accept. 16 kHz mono keeps a 60 s
 * message around 1.9 MB (the upload cap is 5 MB) and is plenty for speech.
 */
export const VOICEMAIL_SAMPLE_RATE = 16000;

/** Encode mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Decode a recorded blob, downmix + resample to 16 kHz mono and return it as a WAV blob. */
export async function recordingToWav(blob: Blob): Promise<{ wav: Blob; seconds: number }> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('This browser cannot process audio.');
  const ctx = new Ctor();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * VOICEMAIL_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, VOICEMAIL_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination); // a 1-channel destination downmixes stereo by averaging
    source.start();
    const rendered = await offline.startRendering();
    return {
      wav: encodeWavPcm16(rendered.getChannelData(0), VOICEMAIL_SAMPLE_RATE),
      seconds: decoded.duration,
    };
  } finally {
    void ctx.close().catch(() => undefined);
  }
}
