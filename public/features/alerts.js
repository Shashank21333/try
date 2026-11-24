// Feature tab: Alerts (stub — to be implemented). Uses helpers from window.TubeScout (see public/app.js).
const T = window.TubeScout;
T.registerTab({
  id: 'alerts',
  label: 'Alerts',
  before: 'me',
  onShow(el) { el.innerHTML = T.card('Alerts', 'Coming soon.', ''); },
});
