// Feature tab: Audit (stub — to be implemented). Uses helpers from window.TubeScout (see public/app.js).
const T = window.TubeScout;
T.registerTab({
  id: 'audit',
  label: 'Audit',
  before: 'tracking',
  onShow(el) { el.innerHTML = T.card('Audit', 'Coming soon.', ''); },
});
