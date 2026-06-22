/**
 * A gentle "arrival" sound played once when the page opens: a soft
 * pentatonic chime over a brief wash of ocean-like noise. Fully
 * synthesized with the Web Audio API — no audio files needed.
 *
 * Browsers block audio until a user gesture, so we try immediately and,
 * if still blocked, play on the first pointer/touch/key interaction.
 */
export function initOpenSound() {
  const AudioCtx =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) return

  let played = false

  const play = async () => {
    if (played) return
    const ctx = new AudioCtx()
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        /* still blocked — wait for the next gesture */
      }
    }
    if (ctx.state !== 'running') return

    played = true
    schedule(ctx)
    detach()
  }

  const detach = () => {
    window.removeEventListener('pointerdown', play)
    window.removeEventListener('touchstart', play)
    window.removeEventListener('keydown', play)
  }

  window.addEventListener('pointerdown', play)
  window.addEventListener('touchstart', play)
  window.addEventListener('keydown', play)

  // attempt right away (works if the context is already allowed)
  play()
}

function schedule(ctx: AudioContext) {
  const master = ctx.createGain()
  master.gain.value = 0.5
  master.connect(ctx.destination)

  oceanWash(ctx, master)

  // soft ascending pentatonic chime (C5 E5 G5 A5 C6)
  const notes = [523.25, 659.25, 783.99, 880.0, 1046.5]
  notes.forEach((freq, i) => {
    tone(ctx, master, freq, 0.05 + i * 0.13, 1.4, 0.16)
    // quiet octave shimmer underneath
    tone(ctx, master, freq * 2, 0.05 + i * 0.13, 0.9, 0.04, 'triangle')
  })
}

function tone(
  ctx: AudioContext,
  dest: AudioNode,
  freq: number,
  startOffset: number,
  duration: number,
  peak: number,
  type: OscillatorType = 'sine',
) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  osc.connect(gain).connect(dest)

  const t0 = ctx.currentTime + startOffset
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.05)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)

  osc.start(t0)
  osc.stop(t0 + duration + 0.1)
}

/** A short, soft swell of filtered noise — like a wave rolling in. */
function oceanWash(ctx: AudioContext, dest: AudioNode) {
  const dur = 2.0
  const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

  const noise = ctx.createBufferSource()
  noise.buffer = buffer

  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = 550
  filter.Q.value = 0.7

  const gain = ctx.createGain()
  const t0 = ctx.currentTime
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.linearRampToValueAtTime(0.12, t0 + 0.7)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

  noise.connect(filter).connect(gain).connect(dest)
  noise.start(t0)
  noise.stop(t0 + dur)
}
