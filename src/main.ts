import './style.css'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <img src="/beach-scene-zoomed.png" alt="Sebuah persinggahan yang damai" class="scene-img" />
  
  <div class="greeting-overlay">
    <h1 class="greeting-text">Sebuah Persinggahan</h1>
    <p class="greeting-subtext">Menepi sejenak dari riuhnya dunia.<br/>Terima kasih telah mampir ke sini.</p>
  </div>
`
