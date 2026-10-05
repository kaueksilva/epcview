/**
 * UHNUI - shell compartilhado do painel EPCVIEW.
 * (O nome UHNUI ficou: as telas e os painéis herdados do UHNIntegra chamam por ele.)
 *
 * Monta a barra lateral (navegação + usuário da sessão) e os avisos flutuantes.
 * Centralizado porque as cópias por página divergiram no passado: a galeria
 * não era alcançável do editor e um link apontava para caminho inexistente.
 */
(function (global) {
    'use strict';

    let usuarioAtual = null;

    // `secao` agrupa o menu como no mockup da plataforma: o dia a dia em cima,
    // a gestão do sistema embaixo.
    const ITENS = [
        { chave: 'editor', secao: 'admin', href: 'index.html', rotulo: 'Editor', somenteAdmin: true, icone:
            '<path d="m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16"/>' },
        { chave: 'galeria', secao: 'plataforma', href: 'lista_dashboards.html', rotulo: 'Dashboards', icone:
            '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/>' +
            '<rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>' },
        { chave: 'planilhas', secao: 'plataforma', href: 'planilhas.html', rotulo: 'Planilhas', icone:
            '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M3 15h18"/>' },
        { chave: 'usuarios', secao: 'admin', href: 'usuarios.html', rotulo: 'Usuários', somenteAdmin: true, icone:
            '<path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7" r="3.5"/>' +
            '<path d="M22 20v-1.5a4 4 0 0 0-3-3.85"/><path d="M16.5 3.6a4 4 0 0 1 0 7.3"/>' },
        { chave: 'contatos', secao: 'admin', href: 'contatos.html', rotulo: 'Contatos', somenteAdmin: true, icone:
            '<path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/><path d="m3 7 9 6 9-6"/>' },
        { chave: 'dockers', secao: 'admin', href: 'dockers.html', rotulo: 'Dockers', somenteAdmin: true, icone:
            '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
            '<rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>' },
        { chave: 'aplicacoes', secao: 'plataforma', href: null, rotulo: 'Aplicações', icone:
            '<circle cx="6.5" cy="6.5" r="3.2"/><circle cx="17.5" cy="6.5" r="3.2"/>' +
            '<circle cx="6.5" cy="17.5" r="3.2"/><circle cx="17.5" cy="17.5" r="3.2"/>' }
    ];

    const icone = (caminho, tamanho) =>
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" style="width:' + (tamanho || 17) + 'px;height:' +
        (tamanho || 17) + 'px;flex-shrink:0">' + caminho + '</svg>';

    const SECOES = { plataforma: 'Plataforma', admin: 'Administração' };

    /** O "V" da marca: um vetor, com o degradê azul institucional → ciano. */
    const V_MARCA =
        '<svg class="logo-epc-v" viewBox="0 0 78 72" aria-hidden="true">' +
          '<defs><linearGradient id="epc-v-grad" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="#0A6CF0"/><stop offset="1" stop-color="#00C2FF"/>' +
          '</linearGradient></defs>' +
          '<path d="M0 0h22l17 45L56 0h22L49 72H29Z" fill="url(#epc-v-grad)"/>' +
        '</svg>';

    /** Logo EPCVIEW em HTML. `claro`: versão para fundo branco. `semSub`: sem "Engineering Intelligence". */
    function logo(opcoes) {
        const o = opcoes || {};
        return '<span class="logo-epc' + (o.claro ? ' logo-epc-claro' : '') + (o.classe ? ' ' + o.classe : '') + '" ' +
            'role="img" aria-label="EPCVIEW">' +
            '<span class="logo-epc-nome">EPC' + V_MARCA + 'IEW</span>' +
            (o.semSub ? '' : '<span class="logo-epc-sub">Engineering Intelligence</span>') +
            '</span>';
    }

    function escapar(texto) {
        const d = document.createElement('div');
        d.textContent = texto == null ? '' : String(texto);
        return d.innerHTML;
    }

    /** Lista resumida de painéis publicados, para o grupo expansível "Dashboards" da barra lateral. */
    async function carregarPaineisResumo() {
        try {
            const resp = await fetch('/api/dashboards', { credentials: 'same-origin' });
            if (!resp.ok) return [];
            const lista = await resp.json();
            return lista.slice().sort((a, b) =>
                String(a.titulo || '').localeCompare(String(b.titulo || ''), 'pt-BR', { numeric: true }));
        } catch {
            return [];
        }
    }

    /** Aplicações (Dockers) que o usuário pode abrir, para o grupo expansível "Aplicações". */
    async function carregarAppsResumo() {
        try {
            const resp = await fetch('/api/dockers?menu=1', { credentials: 'same-origin' });
            if (!resp.ok) return [];
            const lista = await resp.json();
            return lista.slice().sort((a, b) => String(a.titulo || '').localeCompare(String(b.titulo || ''), 'pt-BR'));
        } catch {
            return [];
        }
    }

    /** Busca o usuário da sessão; redireciona para o login se não houver. */
    async function carregarUsuario() {
        if (usuarioAtual) return usuarioAtual;
        try {
            const resp = await fetch('/api/sessao/eu', { credentials: 'same-origin' });
            if (!resp.ok) {
                location.href = '/login.html?destino=' + encodeURIComponent(location.pathname + location.search);
                return null;
            }
            usuarioAtual = (await resp.json()).usuario;
            return usuarioAtual;
        } catch {
            return null;
        }
    }

    async function sair() {
        await fetch('/api/sessao/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
        location.href = '/';
    }

    const CHAVE_LATERAL = 'epc:lateral-recolhida';

    /** Aberto por padrão na primeira visita, para quem nunca viu o recurso perceber que ele existe. */
    function preferenciaGrupo(chave) {
        try {
            const valor = localStorage.getItem('epc:grupo-' + chave + '-aberto');
            return valor === null ? true : valor === '1';
        } catch {
            return true;
        }
    }

    function alternarGrupo(chave) {
        const grupo = document.getElementById('bl-grupo-' + chave);
        const botao = document.getElementById('bl-seta-' + chave);
        if (!grupo || !botao) return;
        const aberto = grupo.classList.toggle('aberto');
        botao.setAttribute('aria-expanded', String(aberto));
        try { localStorage.setItem('epc:grupo-' + chave + '-aberto', aberto ? '1' : '0'); } catch { /* modo privado */ }
    }

    /**
     * A preferencia de menu recolhido vale para todas as telas e persiste
     * entre visitas: quem trabalha com a lateral fechada nao quer reabri-la
     * a cada navegacao.
     */
    function aplicarPreferenciaLateral() {
        let recolhida = false;
        try { recolhida = localStorage.getItem(CHAVE_LATERAL) === '1'; } catch { /* modo privado */ }
        document.body.classList.toggle('lateral-recolhida', recolhida);
    }

    function atualizarTituloRecolher() {
        const botao = document.getElementById('bl-recolher');
        if (!botao) return;
        const recolhida = document.body.classList.contains('lateral-recolhida');
        const texto = recolhida ? 'Expandir menu' : 'Recolher menu';
        botao.title = texto;
        botao.setAttribute('aria-label', texto);
        botao.setAttribute('aria-expanded', String(!recolhida));
    }

    function alternarLateral() {
        const recolhida = document.body.classList.toggle('lateral-recolhida');
        try { localStorage.setItem(CHAVE_LATERAL, recolhida ? '1' : '0'); } catch { /* modo privado */ }
        atualizarTituloRecolher();
        // O Monaco e os graficos precisam saber que o espaco mudou.
        setTimeout(() => window.dispatchEvent(new Event('resize')), 320);
    }

    /** Grupo expansível genérico: cabeçalho (link ou só rótulo) + seta + lista indentada abaixo. */
    function renderizarGrupoExpansivel(item, ativa, subItensHtml, chave, mensagemVazia, forcarAberto) {
        // Com um item ativo lá dentro, abre mesmo que a preferência salva seja "fechado" —
        // esconder o próprio destaque que o usuário veio ver seria pior que ignorar a preferência.
        const aberto = forcarAberto || preferenciaGrupo(chave);
        const conteudo = subItensHtml.length ? subItensHtml.join('') : '<p class="bl-sub-vazio">' + mensagemVazia + '</p>';
        const classeAtiva = item.chave === ativa ? ' ativo' : '';
        const rotuloTag = item.href
            ? '<a href="' + item.href + '" data-rotulo="' + item.rotulo + '" class="bl-item bl-grupo-rotulo' + classeAtiva + '">' +
                icone(item.icone) + '<span>' + item.rotulo + '</span></a>'
            : '<span data-rotulo="' + item.rotulo + '" class="bl-item bl-grupo-rotulo' + classeAtiva + '">' +
                icone(item.icone) + '<span>' + item.rotulo + '</span></span>';

        return (
            '<div class="bl-grupo' + (aberto ? ' aberto' : '') + '" id="bl-grupo-' + chave + '">' +
              '<div class="bl-grupo-linha">' +
                rotuloTag +
                '<button type="button" class="bl-seta-btn" id="bl-seta-' + chave + '" ' +
                'aria-expanded="' + aberto + '" aria-controls="bl-sub-' + chave + '" ' +
                'title="Mostrar ' + item.rotulo.toLowerCase() + '" aria-label="Mostrar ' + item.rotulo.toLowerCase() + '">' +
                  icone('<path d="m9 6 6 6-6 6"/>', 15) +
                '</button>' +
              '</div>' +
              '<div class="bl-sub" id="bl-sub-' + chave + '"><div class="bl-sub-inner">' + conteudo + '</div></div>' +
            '</div>'
        );
    }

    /** Renderiza um item de navegação; "galeria" e "aplicacoes" viram grupos expansíveis. */
    function renderizarItemNav(item, ativa, contexto) {
        if (item.chave === 'galeria') {
            const subItens = contexto.paineis.map(p =>
                '<a class="bl-sub-item' + (p.id === contexto.subAtiva ? ' ativo' : '') + '" href="viewer.html?id=' + encodeURIComponent(p.id) + '">' +
                escapar(p.titulo || 'Sem título') + '</a>');
            const temAtivo = contexto.paineis.some(p => p.id === contexto.subAtiva);
            return renderizarGrupoExpansivel(item, ativa, subItens, 'galeria', 'Nenhum painel publicado ainda.', temAtivo);
        }

        if (item.chave === 'aplicacoes') {
            // Sem nenhuma aplicação liberada pro grupo, a seção some — não fica um item morto no menu.
            if (!contexto.apps.length) return '';
            const subItens = contexto.apps.map(a =>
                '<a class="bl-sub-item" href="/' + encodeURIComponent(a.extensaoUrl) + '/" target="_blank" rel="noopener">' +
                escapar(a.titulo || a.extensaoUrl) + '</a>');
            return renderizarGrupoExpansivel(item, ativa, subItens, 'aplicacoes', 'Nenhuma aplicação disponível.');
        }

        return '<a href="' + item.href + '" data-rotulo="' + item.rotulo + '" ' +
            'class="bl-item' + (item.chave === ativa ? ' ativo' : '') + '">' +
            icone(item.icone) + '<span>' + item.rotulo + '</span></a>';
    }

    /** `subAtiva` destaca um item dentro de um grupo expansível — o id do painel aberto em viewer.html, por exemplo. */
    async function montarBarraLateral(ativa, subAtiva) {
        aplicarPreferenciaLateral();
        const alvo = document.getElementById('barra-lateral');
        if (!alvo) return null;

        const [usuario, paineis, apps] = await Promise.all([
            carregarUsuario(), carregarPaineisResumo(), carregarAppsResumo()
        ]);
        if (!usuario) return null;

        const ehAdmin = usuario.papel === 'admin';
        const paginasPermitidas = (usuario.permissoes && usuario.permissoes.paginas) || 'todos';
        const podeVerPagina = chave => ehAdmin || paginasPermitidas === 'todos' || paginasPermitidas.includes(chave);
        const visiveis = ITENS.filter(i => {
            if (i.somenteAdmin) return ehAdmin;
            if (i.chave === 'galeria' || i.chave === 'planilhas') return podeVerPagina(i.chave);
            return true;
        });
        const contexto = { paineis, apps, subAtiva };

        // Itens na ordem das seções; o rótulo da seção só aparece se ela tiver algo visível.
        let navHtml = '';
        for (const secao of Object.keys(SECOES)) {
            const itens = visiveis.filter(i => i.secao === secao).map(i => renderizarItemNav(i, ativa, contexto)).filter(Boolean);
            if (itens.length) navHtml += '<p class="bl-secao">' + SECOES[secao] + '</p>' + itens.join('');
        }

        alvo.className = 'barra-lateral';
        alvo.innerHTML =
            '<a class="bl-marca" href="lista_dashboards.html" title="EPCVIEW — início">' +
              logo({ classe: 'bl-marca-logo' }) +
              '<img class="bl-marca-icone" src="/favicon.svg" alt="EPCVIEW">' +
            '</a>' +

            '<nav class="bl-nav">' + navHtml + '</nav>' +

              '<a class="bl-site" href="/" title="Abrir o site público">' +
                icone('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>', 15) +
                '<span>Ver site público</span>' +
              '</a>' +

              '<button class="bl-recolher" id="bl-recolher">' +
                icone('<path d="m15 18-6-6 6-6"/>', 16) + '<span>Recolher</span>' +
              '</button>' +

            '<div class="bl-usuario">' +
              '<div class="bl-avatar">' + escapar((usuario.nome || usuario.login).slice(0, 2).toUpperCase()) + '</div>' +
              '<div class="bl-usuario-info">' +
                '<p class="bl-usuario-nome">' + escapar(usuario.nome || usuario.login) + '</p>' +
                '<p class="bl-usuario-papel">' + (ehAdmin ? 'Administrador' : 'Visualizador') + '</p>' +
              '</div>' +
              '<button class="bl-sair" id="bl-sair" title="Sair do sistema" aria-label="Sair">' +
                icone('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>', 16) +
              '</button>' +
            '</div>';

        document.getElementById('bl-sair').addEventListener('click', sair);

        document.getElementById('bl-recolher').addEventListener('click', alternarLateral);
        atualizarTituloRecolher();

        alvo.querySelectorAll('.bl-seta-btn').forEach(botaoSeta =>
            botaoSeta.addEventListener('click', () => alternarGrupo(botaoSeta.id.replace(/^bl-seta-/, ''))));

        return usuario;
    }

    /** Notificação discreta — substitui os alert() que travavam a interface. */
    function aviso(mensagem, tipo) {
        let pilha = document.getElementById('uhn-avisos');
        if (!pilha) {
            pilha = document.createElement('div');
            pilha.id = 'uhn-avisos';
            pilha.className = 'pilha-avisos';
            document.body.appendChild(pilha);
        }

        const icones = {
            sucesso: '<path d="M20 6 9 17l-5-5"/>',
            erro: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
            alerta: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17.5h.01"/>',
            info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'
        };
        const chave = icones[tipo] ? tipo : 'info';

        const item = document.createElement('div');
        item.className = 'aviso aviso-' + chave;
        item.innerHTML = icone(icones[chave], 16) + '<span></span>';
        item.querySelector('span').textContent = mensagem;   // seguro: erro pode trazer HTML
        pilha.appendChild(item);

        requestAnimationFrame(() => item.classList.add('visivel'));
        setTimeout(() => {
            item.classList.remove('visivel');
            setTimeout(() => item.remove(), 220);
        }, 3800);
    }

    /** Confirmação em modal — o confirm() nativo destoa do resto da interface. */
    function confirmar({ titulo, texto, confirmar: rotulo, perigo }) {
        return new Promise(resolve => {
            const fundo = document.createElement('div');
            fundo.className = 'modal-fundo';
            fundo.innerHTML =
                '<div class="modal surgir" role="dialog" aria-modal="true">' +
                  '<h2 class="modal-titulo"></h2>' +
                  '<p class="modal-texto"></p>' +
                  '<div class="modal-acoes">' +
                    '<button class="btn btn-contorno" data-acao="nao">Cancelar</button>' +
                    '<button class="btn ' + (perigo ? 'btn-confirmar-perigo' : 'btn-primario') + '" data-acao="sim"></button>' +
                  '</div>' +
                '</div>';
            fundo.querySelector('.modal-titulo').textContent = titulo || 'Confirmar';
            fundo.querySelector('.modal-texto').textContent = texto || '';
            fundo.querySelector('[data-acao="sim"]').textContent = rotulo || 'Confirmar';

            const fechar = valor => { fundo.remove(); document.removeEventListener('keydown', aoTeclar); resolve(valor); };
            const aoTeclar = e => { if (e.key === 'Escape') fechar(false); };

            fundo.querySelector('[data-acao="nao"]').addEventListener('click', () => fechar(false));
            fundo.querySelector('[data-acao="sim"]').addEventListener('click', () => fechar(true));
            fundo.addEventListener('click', e => { if (e.target === fundo) fechar(false); });
            document.addEventListener('keydown', aoTeclar);

            document.body.appendChild(fundo);
            fundo.querySelector('[data-acao="sim"]').focus();
        });
    }

    function tamanhoLegivel(bytes) {
        if (!bytes) return '—';
        const u = ['B', 'KB', 'MB', 'GB'];
        let i = 0, n = bytes;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
    }

    function dataRelativa(iso) {
        if (!iso) return 'sem data';
        const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
        if (min < 1) return 'agora mesmo';
        if (min < 60) return 'há ' + min + ' min';
        const h = Math.round(min / 60);
        if (h < 24) return 'há ' + h + 'h';
        const d = Math.round(h / 24);
        if (d < 30) return 'há ' + d + (d === 1 ? ' dia' : ' dias');
        return new Date(iso).toLocaleDateString('pt-BR');
    }

    global.UHNUI = {
        montarBarraLateral, carregarUsuario, sair, alternarLateral,
        aviso, confirmar, icone, escapar, tamanhoLegivel, dataRelativa, logo,
        get usuario() { return usuarioAtual; }
    };
})(window);
