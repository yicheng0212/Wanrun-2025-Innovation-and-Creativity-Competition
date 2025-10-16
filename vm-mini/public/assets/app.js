// 全站共用 JS：導覽互動、Toast 工具、動畫輔助
(function(){
  const App = {
    bootstrapToast(msg, variant = 'primary', title = '提醒'){
      const containerId = 'global-toast-container';
      let container = document.getElementById(containerId);
      if(!container){
        container = document.createElement('div');
        container.className = 'toast-container position-fixed top-0 end-0 p-3';
        container.id = containerId;
        document.body.appendChild(container);
      }

      const toastEl = document.createElement('div');
      toastEl.className = `toast align-items-center text-bg-${variant}`;
      toastEl.innerHTML = `
        <div class="d-flex">
          <div class="toast-body">
            <strong class="me-2">${title}</strong>${msg}
          </div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
      `;
      container.appendChild(toastEl);

      const toast = new bootstrap.Toast(toastEl, { delay: 2500 });
      toast.show();

      toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
    },
    highlightActiveNav(){
      const path = location.pathname.replace(/index\.html$/, '');
      document.querySelectorAll('.navbar .nav-link').forEach(link=>{
        const href = link.getAttribute('href');
        const normalized = href ? href.replace(/index\.html$/, '') : '';
        if(normalized && path.endsWith(normalized)){
          link.classList.add('active', 'fw-semibold');
        } else {
          link.classList.remove('active', 'fw-semibold');
        }
      });
    },
    formatMoney(cents){
      return '$' + (Number(cents || 0) / 100).toFixed(0);
    },
    animateCounter(el, target, suffix=''){
      if(!el) return;
      const duration = 700;
      const start = performance.now();
      const from = Number(el.dataset.from || 0);
      const to = Number(target);

      function tick(now){
        const progress = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = (from + (to - from) * eased).toFixed(0) + suffix;
        if(progress < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      el.dataset.from = to;
    },
    autoFocus(selector){
      const el = document.querySelector(selector);
      if(el){
        setTimeout(()=>el.focus(), 120);
      }
    },
    attachScanHandler(selector, callback, options = {}){
      const target = typeof selector === 'string' ? document.querySelector(selector) : selector;
      if(!target || typeof callback !== 'function') return;
      const minLength = options.minLength ?? 3;
      const resetDelay = options.resetDelay ?? 120;
      let timer = null;

      const trigger = ()=>{
        const payload = target.value.trim();
        target.value = '';
        if(!payload && options.skipEmpty) return;
        callback(payload);
      };

      target.addEventListener('keydown', ev=>{
        if(ev.key === 'Enter'){
          ev.preventDefault();
          trigger();
        }
      });

      if(options.autoTrigger){
        target.addEventListener('input', ()=>{
          if(target.value.length >= minLength){
            clearTimeout(timer);
            timer = setTimeout(trigger, resetDelay);
          }
        });
      }
    },
    initMachineChrome(){
      const clockEl = document.getElementById('vmClock');
      const statusEl = document.getElementById('vmStatusText');
      const statusPill = document.getElementById('vmStatusPill');
      if(!clockEl && !statusEl) return;

      const statusMessages = [
        '系統待命',
        '冷藏穩定',
        '補貨完成',
        'ESG 同步中'
      ];

      function updateClock(){
        if(clockEl){
          const now = new Date();
          const time = now.toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'});
          clockEl.textContent = time;
        }
      }

      function updateStatus(){
        if(statusEl){
          const message = statusMessages[Math.floor(Date.now()/5000)%statusMessages.length];
          statusEl.textContent = message;
        }
        if(statusPill){
          statusPill.classList.toggle('text-success', true);
        }
      }

      updateClock();
      updateStatus();
      setInterval(updateClock, 20000);
      setInterval(updateStatus, 6000);
    }
  };

  window.App = App;

  document.addEventListener('DOMContentLoaded', ()=>{
    App.highlightActiveNav();
    App.initMachineChrome();
  });
})();
