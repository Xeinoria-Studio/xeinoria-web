function $(id) {
  return document.getElementById(id);
}

function setTextAll(selector, value) {
  const elements = document.querySelectorAll(selector);
  elements.forEach((el) => {
    el.textContent = value;
  });
}

function applyTheme(theme) {
  if (!theme) {
    return;
  }

  const root = document.documentElement;
  root.style.setProperty('--bg-image', `url('${theme.backgroundImage}')`);
  root.style.setProperty('--bg-blur', `${theme.blurPx}px`);
  root.style.setProperty('--bg-overlay', String(theme.overlayOpacity));
}

function setText(id, value) {
  const el = $(id);
  if (el) {
    el.textContent = value;
  }
}

function setHtml(id, value) {
  const el = $(id);
  if (el) {
    el.innerHTML = value;
  }
}

function renderStatus(data) {
  const statusPill = $('statusPill');
  const maintenancePill = $('maintenancePill');

  if (statusPill) {
    statusPill.textContent = data.online ? 'ONLINE' : 'OFFLINE';
    statusPill.className = `pill ${data.online ? 'online' : 'offline'}`;
  }

  if (maintenancePill) {
    maintenancePill.textContent = data.maintenance ? 'MAINTENANCE' : 'LIVE';
    maintenancePill.className = `pill ${data.maintenance ? 'maintenance' : 'online'}`;
  }

  setText('playersOnline', String(data.playersOnline));
  setText('playersMax', String(data.playersMax));
  setHtml('motdValue', data.motdHtml || data.motd || '-');
  setText('checkedAt', new Date(data.checkedAt).toLocaleString());
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const data = await response.json();
    if (data.ok) {
      renderStatus(data);
    }
  } catch {
    renderStatus({
      online: false,
      maintenance: false,
      playersOnline: 0,
      playersMax: 0,
      motd: '-',
      motdHtml: '-',
      checkedAt: new Date().toISOString()
    });
  }
}

async function loadSiteConfig() {
  try {
    const response = await fetch('/api/site-config', { cache: 'no-store' });
    const data = await response.json();
    if (!data.ok) {
      return;
    }

    setText('serverName', data.serverDisplayName);
    setTextAll('.join-ip', data.serverJoinIp);
    applyTheme(data.theme);

    const twitchLinks = document.querySelectorAll('[data-twitch-link]');
    twitchLinks.forEach((twitchLink) => {
      twitchLink.href = data.twitchUrl;
    });

    const contactMail = $('contactEmail');
    const contactLink = $('contactEmailLink');
    if (contactMail) {
      contactMail.textContent = data.contactEmail || 'A venir';
    }

    if (contactLink) {
      if (data.contactEmail) {
        contactLink.href = `mailto:${data.contactEmail}`;
        contactLink.classList.remove('hidden');
      } else {
        contactLink.classList.add('hidden');
      }
    }
  } catch {
    // no-op
  }
}

function renderTwitchLive(data) {
  const card = $('twitchLiveCard');
  const frame = $('twitchEmbed');

  if (!card || !frame) {
    return;
  }

  if (data.live) {
    card.classList.remove('hidden');
    frame.src = data.embedUrl;
    setText('twitchLiveTitle', data.title || 'En direct');
    setText('twitchLiveViewers', String(data.viewerCount || 0));
    return;
  }

  frame.removeAttribute('src');
  setText('twitchLiveTitle', '');
  setText('twitchLiveViewers', '0');
  card.classList.add('hidden');
}

async function refreshTwitchStatus() {
  try {
    const response = await fetch('/api/twitch-status', { cache: 'no-store' });
    const data = await response.json();
    if (data.ok) {
      renderTwitchLive(data);
    }
  } catch {
    renderTwitchLive({ live: false });
  }
}

function bindCopyIp() {
  const buttons = document.querySelectorAll('[data-copy-ip]');
  if (!buttons.length) {
    return;
  }

  buttons.forEach((button) => {
    button.addEventListener('click', async () => {
      const ip = document.querySelector('.join-ip')?.textContent?.trim() || '';
      if (!ip) {
        return;
      }

      try {
        await navigator.clipboard.writeText(ip);
        button.textContent = 'IP copied';
        setTimeout(() => {
          button.textContent = 'Copy IP';
        }, 1200);
      } catch {
        button.textContent = ip;
        setTimeout(() => {
          button.textContent = 'Copy IP';
        }, 2000);
      }
    });
  });
}

function markActiveNav() {
  const page = document.body.dataset.page;
  const links = document.querySelectorAll('[data-nav]');
  links.forEach((link) => {
    if (link.getAttribute('data-nav') === page) {
      link.classList.add('active');
    }
  });
}

function bindReactiveAccent() {
  const root = document.documentElement;
  const palette = ['#52d3ff', '#7fff9f', '#ff8bd9', '#ffd166', '#a78bfa'];
  const targets = document.querySelectorAll('.button, .card, .nav a');

  targets.forEach((target, index) => {
    target.addEventListener('mouseenter', () => {
      const color = palette[index % palette.length];
      root.style.setProperty('--accent', color);
      root.style.setProperty('--accent-soft', `${color}33`);
    });
  });
}

function shouldEnableParticles() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return false;
  }

  const memory = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 8;
  if (memory <= 2 || cores <= 2) {
    return false;
  }

  return true;
}

function initParticles() {
  const canvas = $('particleCanvas');
  if (!canvas || !shouldEnableParticles()) {
    return;
  }

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) {
    return;
  }

  let width = 0;
  let height = 0;
  let rafId = 0;
  let enabled = true;
  let frameCount = 0;
  let lastFpsCheck = performance.now();

  const particles = [];
  const particleCount = Math.min(Math.floor(window.innerWidth / 18), 90);

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
  }

  function random(min, max) {
    return Math.random() * (max - min) + min;
  }

  for (let i = 0; i < particleCount; i += 1) {
    particles.push({
      x: random(0, window.innerWidth),
      y: random(0, window.innerHeight),
      vx: random(-0.22, 0.22),
      vy: random(-0.22, 0.22),
      r: random(0.6, 1.8)
    });
  }

  function tick() {
    if (!enabled) {
      return;
    }

    frameCount += 1;
    const now = performance.now();
    if (now - lastFpsCheck > 2000) {
      const fps = (frameCount * 1000) / (now - lastFpsCheck);
      frameCount = 0;
      lastFpsCheck = now;
      if (fps < 45) {
        enabled = false;
        canvas.style.display = 'none';
        return;
      }
    }

    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < particles.length; i += 1) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < -10 || p.x > width + 10) {
        p.vx *= -1;
      }
      if (p.y < -10 || p.y > height + 10) {
        p.vy *= -1;
      }

      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    rafId = window.requestAnimationFrame(tick);
  }

  resize();
  tick();
  window.addEventListener('resize', resize);
  window.addEventListener('beforeunload', () => window.cancelAnimationFrame(rafId));
}

function init() {
  bindCopyIp();
  bindReactiveAccent();
  markActiveNav();
  loadSiteConfig();
  refreshStatus();
  refreshTwitchStatus();
  initParticles();
  window.setInterval(refreshStatus, 15000);
  window.setInterval(refreshTwitchStatus, 60000);
}

document.addEventListener('DOMContentLoaded', init);
