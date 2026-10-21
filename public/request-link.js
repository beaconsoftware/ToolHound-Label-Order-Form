(function () {
  'use strict';
  var cfg = window.TOOLHOUND_CONFIG || {};
  var address = (cfg.contact || {}).salesEmail || 'graham.cooper@toolhound.com';
  var link = document.getElementById('salesEmail');
  link.textContent = address;
  link.href = 'mailto:' + address;
  document.getElementById('contactPhone').textContent = cfg.supportPhone || '';
})();
