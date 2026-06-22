import './style.css'
import { initOpenSound } from './sound'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <img src="/beach-scene-zoomed.png" alt="Sebuah persinggahan yang damai" class="scene-img" />

  <div class="greeting-wrap">
    <div class="greeting-overlay">
      <h1 class="greeting-text"></h1>
      <p class="greeting-subtext"></p>
    </div>
  </div>
`

const heading = document.querySelector<HTMLHeadingElement>('.greeting-text')!
const subtext = document.querySelector<HTMLParagraphElement>('.greeting-subtext')!

const HEADING_TEXT = 'Singgah Dulu, Yuk'
const SUBTEXT_TEXT = 'Biar penat luruh dibawa ombak. 👋'

/** Types `text` into `el` one character at a time, showing a blinking caret. */
function typeInto(el: HTMLElement, text: string, speed: number): Promise<void> {
  return new Promise((resolve) => {
    el.classList.add('typing')
    let i = 0
    const tick = () => {
      el.innerHTML = text.slice(0, i).replace(/\n/g, '<br/>')
      if (i < text.length) {
        i++
        setTimeout(tick, speed)
      } else {
        resolve()
      }
    }
    tick()
  })
}

async function run() {
  await typeInto(heading, HEADING_TEXT, 70)
  heading.classList.remove('typing')
  await new Promise((r) => setTimeout(r, 350))
  await typeInto(subtext, SUBTEXT_TEXT, 35)
  // caret stays blinking on the subtext once finished
}

// small delay so the scene settles before the greeting starts typing
setTimeout(run, 500)

// gentle arrival chime + ocean wash when the page opens
initOpenSound()
