/**
 * EPCVIEW - site público
 * Menu móvel, atalho para quem já tem sessão,
 * vídeo institucional e a revelação suave das seções ao rolar.
 */
(function () {
    'use strict';

    const $ = id => document.getElementById(id);

    // Ano do rodapé -----------------------------------------------------------
    $('ano').textContent = new Date().getFullYear();

    // Menu móvel ----------------------------------------------------------------
    const cabecalho = $('cabecalho');
    const alternar = $('menu-alternar');
    alternar.addEventListener('click', () => {
        const aberto = cabecalho.classList.toggle('aberto');
        alternar.setAttribute('aria-expanded', String(aberto));
        alternar.setAttribute('aria-label', aberto ? 'Fechar menu' : 'Abrir menu');
    });
    $('menu').addEventListener('click', e => {
        if (e.target.closest('a')) {
            cabecalho.classList.remove('aberto');
            alternar.setAttribute('aria-expanded', 'false');
        }
    });

    // Item do menu ativo conforme a seção visível --------------------------------
    const linksMenu = Array.from(document.querySelectorAll('.menu a[href^="#"]:not([href="#"])'));
    const secoes = linksMenu.map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
    if ('IntersectionObserver' in window) {
        const observador = new IntersectionObserver(entradas => {
            entradas.forEach(en => {
                if (!en.isIntersecting) return;
                linksMenu.forEach(a => a.classList.toggle('ativo', a.getAttribute('href') === '#' + en.target.id));
            });
        }, { rootMargin: '-45% 0px -50% 0px' });
        secoes.forEach(s => observador.observe(s));
    }

    // Quem já está logado vai direto ao painel -----------------------------------
    fetch('/api/sessao/eu', { credentials: 'same-origin' })
        .then(r => (r.ok ? r.json() : null))
        .then(dados => {
            if (!dados || !dados.usuario) return;
            document.querySelectorAll('[data-acesso]').forEach(a => { a.href = '/lista_dashboards.html'; });
            document.querySelectorAll('[data-acesso-rotulo]').forEach(s => { s.textContent = 'Ir para o painel'; });
            const menuEntrar = document.querySelector('.menu-entrar');
            if (menuEntrar) menuEntrar.textContent = 'Ir para o painel';
        })
        .catch(() => { /* sem servidor/sessão: fica "Entrar" */ });

    // Revelação ao rolar -----------------------------------------------------------
    const reveladores = document.querySelectorAll('.revelar');
    const semAnimacao = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!('IntersectionObserver' in window) || semAnimacao) {
        reveladores.forEach(el => el.classList.add('visivel'));
    } else {
        const obs = new IntersectionObserver(entradas => {
            entradas.forEach(en => {
                if (en.isIntersecting) { en.target.classList.add('visivel'); obs.unobserve(en.target); }
            });
        }, { rootMargin: '0px 0px -8% 0px' });
        reveladores.forEach(el => obs.observe(el));
    }

    // Vídeo institucional ------------------------------------------------------------
    const modal = $('video-modal');
    const video = $('video');
    const videoVazio = $('video-vazio');
    let videoCarregado = false;

    function abrirVideo() {
        modal.classList.add('aberto');
        document.body.style.overflow = 'hidden';
        if (!videoCarregado) {
            videoCarregado = true;
            video.addEventListener('error', () => { video.hidden = true; videoVazio.classList.add('visivel'); }, { once: true });
            video.src = '/site/video/apresentacao.mp4';
        }
        if (!video.hidden) video.play().catch(() => {});
        $('fechar-video').focus();
    }
    function fecharVideo() {
        modal.classList.remove('aberto');
        document.body.style.overflow = '';
        video.pause();
    }
    $('abrir-video').addEventListener('click', abrirVideo);
    $('fechar-video').addEventListener('click', fecharVideo);
    $('video-contato').addEventListener('click', fecharVideo);
    modal.addEventListener('click', e => { if (e.target === modal) fecharVideo(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('aberto')) fecharVideo(); });

})();
