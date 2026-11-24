// Feature tab: Rankings (stub — to be implemented). Uses helpers from window.TubeScout (see public/app.js).
const T = window.TubeScout;
T.registerTab({
  id: 'ranks',
  label: 'Rankings',
  before: 'tracking',
  onShow(el) { el.innerHTML = T.card('Rankings', 'Coming soon.', ''); },
});
