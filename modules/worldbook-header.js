(function () {
  'use strict';

  function init() {
    const button = document.getElementById('world-book-more-btn');
    const menu = document.getElementById('world-book-dropdown-menu');
    if (!button || !menu) return;

    const close = () => {
      menu.classList.remove('show');
      button.setAttribute('aria-expanded', 'false');
    };

    button.addEventListener('click', event => {
      event.stopPropagation();
      const open = !menu.classList.contains('show');
      menu.classList.toggle('show', open);
      button.setAttribute('aria-expanded', String(open));
    });

    menu.addEventListener('click', event => {
      if (event.target.closest('.worldbook-dropdown-item')) close();
    });

    document.addEventListener('click', event => {
      if (!menu.contains(event.target) && event.target !== button) close();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
