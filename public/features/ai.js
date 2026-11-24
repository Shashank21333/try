// Feature tab: AI Studio (stub — to be implemented). Uses helpers from window.TubeScout (see public/app.js).
const T = window.TubeScout;
T.registerTab({
  id: 'ai',
  label: 'AI Studio',
  before: 'tracking',
  onShow(el) { el.innerHTML = T.card('AI Studio', 'Coming soon.', ''); },
});
