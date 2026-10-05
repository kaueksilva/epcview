/**
 * EPCVIEW - Editor de painéis
 * ---------------------------------------------------------------------------
 * As planilhas do painel não são escolhidas num seletor: o editor lê o código
 * (`dados.P21`, `consultar('P21')`, até o antigo `consultar('SELECT * FROM
 * "planilha_21"')`) e detecta sozinho quais planilhas ele referencia. O que
 * for detectado é o que chega pré-carregado em `dados` e o que é salvo junto
 * com o painel — sem passo manual de "selecionar fontes".
 *
 * A gaveta "Ver planilhas" continua existindo, mas só para consultar colunas
 * e inserir a chamada — não define mais o que roda.
 */
(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Estado
    // -----------------------------------------------------------------------
    let editor = null;
    let usuario = null;
    let idAtual = null;                 // null = painel novo
    let fontes = [];                    // apelidos detectados no código: ['P21', 'P22']
    let planilhas = [];                 // catálogo vindo do servidor
    let planilhaAberta = null;          // detalhe em exibição na gaveta
    let colunasConhecidas = [];         // nomes de coluna das fontes em uso, para o autocomplete
    let salvoRecentemente = '';
    let sandboxPronto = false;
    let execucaoPendente = null;

    const CHAVE_RASCUNHO = 'epc:rascunho';
    const $ = id => document.getElementById(id);

    const ICONES = {
        tabela: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
        medidor: '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M13.4 12.6 19 7"/>' +
                 '<path d="M4.2 18a9 9 0 1 1 15.6 0"/>',
        barras: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16v-4M12 16V8M17 16v-6"/>',
        check: '<path d="M20 6 9 17l-5-5"/>'
    };

    // -----------------------------------------------------------------------
    // Modelos — montados a partir da primeira planilha detectada (ou P21, por padrão)
    // -----------------------------------------------------------------------
    function modelos() {
        const primeira = fontes[0] || 'P21';
        const ref = 'dados.' + primeira;

        return [{
            nome: 'Tabela de conferência',
            descricao: 'Mostra as primeiras linhas. Bom para conferir os dados antes de montar o painel.',
            icone: ICONES.tabela,
            codigo: [
                '// As planilhas referenciadas abaixo chegam prontas em `dados`.',
                'const linhas = ' + ref + ';',
                'const colunas = Object.keys(linhas[0] || {}).slice(0, 8);',
                '',
                'document.getElementById("dash-root").innerHTML = `',
                '  <h1 style="font-size:1.4rem;font-weight:800;margin:0 0 .2rem">' + primeira + '</h1>',
                '  <p style="color:#52707f;margin:0 0 1.2rem">${linhas.length} registros · ${colunas.length} colunas</p>',
                '',
                '  <div style="border:1px solid #e2e9ee;border-radius:12px;overflow:auto">',
                '    <table style="width:100%;border-collapse:collapse;font-size:.8rem">',
                '      <thead>',
                '        <tr>${colunas.map(c => `',
                '          <th style="background:#0a3d5e;color:#fff;padding:.55rem;text-align:left;font-weight:600">${c}</th>',
                '        `).join("")}</tr>',
                '      </thead>',
                '      <tbody>',
                '        ${linhas.slice(0, 25).map(l => `',
                '          <tr>${colunas.map(c => `',
                '            <td style="padding:.5rem;border-top:1px solid #eef3f6;color:#52707f">${l[c] ?? ""}</td>',
                '          `).join("")}</tr>',
                '        `).join("")}',
                '      </tbody>',
                '    </table>',
                '  </div>`;'
            ].join('\n')
        }, {
            nome: 'Cartões de indicadores',
            descricao: 'Faixa de KPIs no topo — o formato mais pedido pela diretoria.',
            icone: ICONES.medidor,
            codigo: [
                'const linhas = ' + ref + ';',
                '',
                '// Troque pelos campos reais (os nomes aparecem no seletor de planilhas).',
                'const kpis = [',
                '  { rotulo: "Registros", valor: linhas.length, cor: "#0a3d5e" },',
                '  { rotulo: "Colunas",   valor: Object.keys(linhas[0] || {}).length, cor: "#3d9b6b" },',
                '  { rotulo: "Atualizado", valor: new Date().toLocaleDateString("pt-BR"), cor: "#c88a3c" }',
                '];',
                '',
                'document.getElementById("dash-root").innerHTML = `',
                '  <h1 style="font-size:1.4rem;font-weight:800;margin:0 0 1.2rem">Indicadores</h1>',
                '  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem">',
                '    ${kpis.map(k => `',
                '      <div style="background:#fff;border:1px solid #e2e9ee;border-top:3px solid ${k.cor};',
                '                  border-radius:12px;padding:1.1rem">',
                '        <p style="margin:0;font-size:.68rem;font-weight:700;color:#8ba2ad;',
                '                  text-transform:uppercase;letter-spacing:.06em">${k.rotulo}</p>',
                '        <p style="margin:.4rem 0 0;font-size:1.9rem;font-weight:800;color:${k.cor}">${k.valor}</p>',
                '      </div>`).join("")}',
                '  </div>`;'
            ].join('\n')
        }, {
            nome: 'Gráfico de barras',
            descricao: 'Plotly já vem carregado. Agrupa pela primeira coluna de texto.',
            icone: ICONES.barras,
            codigo: [
                'const linhas = ' + ref + ';',
                'const colunas = Object.keys(linhas[0] || {});',
                'const chave = colunas.find(c => typeof linhas[0][c] === "string") || colunas[0];',
                '',
                'const contagem = {};',
                'for (const l of linhas) {',
                '  const k = l[chave] ?? "(vazio)";',
                '  contagem[k] = (contagem[k] || 0) + 1;',
                '}',
                'const topo = Object.entries(contagem).sort((a, b) => b[1] - a[1]).slice(0, 12);',
                '',
                'document.getElementById("dash-root").innerHTML = `',
                '  <h1 style="font-size:1.4rem;font-weight:800;margin:0 0 1rem">Distribuição por ${chave}</h1>',
                '  <div id="grafico" style="background:#fff;border:1px solid #e2e9ee;border-radius:12px;padding:.5rem"></div>`;',
                '',
                'Plotly.newPlot("grafico", [{',
                '  type: "bar",',
                '  x: topo.map(t => t[0]),',
                '  y: topo.map(t => t[1]),',
                '  marker: { color: "#1a5f8e" }',
                '}], {',
                '  height: 420,',
                '  margin: { t: 20, r: 20, b: 90, l: 55 },',
                '  font: { family: "Inter, sans-serif", size: 11, color: "#52707f" },',
                '  plot_bgcolor: "#fff", paper_bgcolor: "#fff",',
                '  yaxis: { gridcolor: "#eef3f6" }',
                '}, { responsive: true, displayModeBar: false });'
            ].join('\n')
        }];
    }

    function codigoInicial() {
        return [
            '// Bem-vindo ao editor do EPCVIEW.',
            '//',
            '// 1. Escreva `dados.P21` (ou `await consultar("P21")`) no código.',
            '// 2. O painel detecta sozinho e carrega a planilha — sem selecionar nada.',
            '// 3. Ctrl+Enter executa, Ctrl+S publica.',
            '//',
            '// Clique em "Ver planilhas" para conferir os nomes das colunas antes de escrever.',
            '',
            'document.getElementById("dash-root").innerHTML = `',
            '  <div style="padding:2rem;text-align:center;color:#52707f">',
            '    <h1 style="color:#0a3d5e;font-size:1.3rem;margin:0 0 .5rem">Painel em branco</h1>',
            '    <p style="margin:0">Escolha as planilhas e abra os Modelos para começar.</p>',
            '  </div>`;'
        ].join('\n');
    }

    // -----------------------------------------------------------------------
    // Console
    // -----------------------------------------------------------------------
    function log(mensagem, nivel) {
        $('console').classList.add('visivel');
        $('btn-console').classList.add('ligado');

        const linha = document.createElement('div');
        linha.className = 'cl' + (nivel ? ' cl-' + nivel : '');

        const hora = document.createElement('span');
        hora.className = 'cl-hora';
        hora.textContent = new Date().toLocaleTimeString('pt-BR', { hour12: false });

        const texto = document.createElement('span');
        texto.className = 'cl-msg';
        texto.textContent = mensagem;      // textContent: erros podem trazer HTML

        linha.append(hora, texto);
        $('console-linhas').appendChild(linha);
        $('console-linhas').scrollTop = $('console-linhas').scrollHeight;
        if (editor) editor.layout();
    }

    // -----------------------------------------------------------------------
    // Execução
    // -----------------------------------------------------------------------
    async function executar() {
        if (!editor) return;

        // Garante que `fontes` reflete o código atual mesmo se o debounce da
        // digitação ainda não tiver disparado (ex.: colar código e apertar
        // Ctrl+Enter na sequência). listarPlanilhas() já vem do cache do
        // runtime, então isso raramente causa espera perceptível.
        await sincronizarFontes();

        $('preview-vazio').style.display = 'none';
        $('status-preview').textContent = 'executando...';

        const msg = {
            fonte: 'uhn-host', tipo: 'executar',
            codigo: editor.getValue(),
            fontes: fontes.slice(),
            recarregar: false
        };
        if (sandboxPronto) $('preview').contentWindow.postMessage(msg, '*');
        else execucaoPendente = msg;

        log('Executando' + (fontes.length ? ' com ' + fontes.join(', ') : '') + '...');
    }

    window.addEventListener('message', ev => {
        const d = ev.data;
        if (!d || d.fonte !== 'uhn-sandbox') return;

        if (d.tipo === 'aguardando') {
            sandboxPronto = true;
            if (execucaoPendente) {
                $('preview').contentWindow.postMessage(execucaoPendente, '*');
                execucaoPendente = null;
            }
        }
        if (d.tipo === 'pronto') {
            $('status-preview').innerHTML = '<span style="color:var(--ok);font-weight:600">✓ ' + d.ms + 'ms</span>';
            log('Painel renderizado em ' + d.ms + 'ms.', 'ok');
        }
        if (d.tipo === 'erro') {
            $('status-preview').innerHTML = '<span style="color:var(--erro);font-weight:600">erro</span>';
            log(d.mensagem, 'erro');
        }
        if (d.tipo === 'console') {
            log(d.mensagem, d.nivel === 'error' ? 'erro' : d.nivel === 'warn' ? 'aviso' : null);
        }
    });

    // -----------------------------------------------------------------------
    // Fontes — detectadas automaticamente a partir do código
    // -----------------------------------------------------------------------

    /**
     * Extrai do código os alvos de `dados.X` e `consultar(...)`, incluindo o
     * formato antigo `consultar('SELECT * FROM "planilha_21"')`. O regex do
     * SQL é o mesmo que o runtime usa em tempo de execução (uhn-runtime.js),
     * para a detecção nunca divergir do que o painel de fato vai carregar.
     */
    function detectarFontesNoCodigo(codigo) {
        const candidatos = new Set();

        for (const m of codigo.matchAll(/\bdados\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
            if (m[1] !== '_erros') candidatos.add(m[1]);
        }

        for (const m of codigo.matchAll(/\bconsultar\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) {
            const bruto = m[2];
            const viaSql = bruto.match(/FROM\s+["'`]?([^"'`\s]+(?:[^"'`]*[^"'`\s])?)["'`]?/i);
            candidatos.add((viaSql ? viaSql[1] : bruto).trim());
        }
        return [...candidatos].filter(Boolean);
    }

    // Evita recalcular a cada tecla digitada; roda ~400ms depois da última.
    let temporizadorFontes = null;
    function agendarSincronizarFontes() {
        clearTimeout(temporizadorFontes);
        temporizadorFontes = setTimeout(sincronizarFontes, 400);
    }

    /**
     * Resolve os candidatos do código contra o catálogo real de planilhas e
     * atualiza `fontes`. Candidatos que não correspondem a nenhum arquivo são
     * ignorados aqui — na execução, `consultar()` avisa sobre eles com uma
     * mensagem própria, não é papel desta função duplicar esse erro.
     */
    async function sincronizarFontes() {
        const codigo = editor ? editor.getValue() : '';
        const candidatos = detectarFontesNoCodigo(codigo);

        if (!candidatos.length) {
            fontes = [];
            colunasConhecidas = [];
            desenharChips();
            if ($('gaveta').classList.contains('aberta')) desenharListaFontes();
            return;
        }

        if (!planilhas.length) {
            try { planilhas = await UHN.listarPlanilhas(); }
            catch { /* offline ou sem planilhas ainda: mantém a lista vazia */ }
        }

        const resolvidas = new Set();
        for (const candidato of candidatos) {
            const nomeArquivo = UHN.resolverArquivo(candidato, planilhas);
            if (!nomeArquivo) continue;
            const item = planilhas.find(p => p.nome === nomeArquivo);
            resolvidas.add((item && item.apelido) || nomeArquivo);
        }

        fontes = [...resolvidas].sort((a, b) => {
            const na = parseInt(String(a).replace(/\D/g, ''), 10);
            const nb = parseInt(String(b).replace(/\D/g, ''), 10);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            return String(a).localeCompare(String(b));
        });

        desenharChips();
        if ($('gaveta').classList.contains('aberta')) desenharListaFontes();
        atualizarColunasConhecidas();
    }

    /**
     * Busca as colunas das fontes agora em uso, para alimentar o autocomplete
     * do Monaco. UHN.consultar() já mantém cache por planilha, então isso não
     * gera um download novo a cada tecla — só na primeira vez que uma fonte
     * aparece no código.
     */
    async function atualizarColunasConhecidas() {
        const conjunto = new Set();
        for (const apelido of fontes) {
            try {
                const linhas = await UHN.consultar(apelido);
                if (linhas && linhas[0]) Object.keys(linhas[0]).forEach(c => conjunto.add(c));
            } catch { /* planilha ainda nao chegou a existir: sem colunas pra sugerir */ }
        }
        colunasConhecidas = [...conjunto];
    }

    /** Chips só informativos: mostram o que o código usa, sem ação de remover. */
    function desenharChips() {
        const lista = $('fontes-lista');
        lista.innerHTML = '';

        if (!fontes.length) {
            const vazio = document.createElement('span');
            vazio.className = 'chip-vazio';
            vazio.textContent = 'Nenhuma planilha detectada — use consultar(\'P21\') ou dados.P21 no código.';
            lista.appendChild(vazio);
            return;
        }

        fontes.forEach(apelido => {
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.title = 'Detectado no código · disponível como dados.' + apelido;

            const texto = document.createElement('span');
            texto.textContent = apelido;
            chip.appendChild(texto);

            chip.addEventListener('click', () => {
                abrirGaveta();
                const p = planilhas.find(x => (x.apelido || x.nome) === apelido);
                if (p) mostrarDetalhe(p);
            });

            lista.appendChild(chip);
        });
    }

    function desenharListaFontes() {
        const lista = $('lista-fontes');
        const termo = $('busca-fontes').value.trim().toLowerCase();
        lista.innerHTML = '';

        const visiveis = planilhas.filter(p =>
            !termo || p.nome.toLowerCase().includes(termo) ||
            (p.apelido || '').toLowerCase().includes(termo));

        $('fontes-contagem').textContent = fontes.length
            ? fontes.length + (fontes.length === 1 ? ' detectada' : ' detectadas')
            : 'nenhuma detectada';

        if (!visiveis.length) {
            const vazio = document.createElement('p');
            vazio.style.cssText = 'padding:1.5rem .8rem;font-size:.78rem;color:var(--texto-3);text-align:center';
            vazio.textContent = planilhas.length
                ? 'Nenhuma planilha corresponde ao filtro.'
                : 'Nenhuma planilha no sistema. Envie arquivos pela aba Planilhas.';
            lista.appendChild(vazio);
            return;
        }

        visiveis.forEach(p => {
            const chave = p.apelido || p.nome;
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'fonte-item' +
                (fontes.includes(chave) ? ' selecionada' : '') +
                (planilhaAberta && planilhaAberta.nome === p.nome ? ' ativa' : '');

            // Só indica se a planilha está em uso; marcar/desmarcar aqui não
            // faria sentido — quem decide é o código, não este clique.
            const check = document.createElement('span');
            check.className = 'fonte-check';
            check.title = fontes.includes(chave) ? 'Em uso no código' : 'Não referenciada no código';
            check.innerHTML = UHNUI.icone(ICONES.check, 11);

            const texto = document.createElement('span');
            texto.className = 'fonte-texto';
            const apelido = document.createElement('div');
            apelido.className = 'fonte-apelido';
            apelido.textContent = chave;
            const nome = document.createElement('div');
            nome.className = 'fonte-nome';
            nome.textContent = p.nome;
            nome.title = p.nome;
            texto.append(apelido, nome);

            const tamanho = document.createElement('span');
            tamanho.style.cssText = 'font-size:.62rem;color:var(--texto-3);flex-shrink:0';
            tamanho.textContent = UHNUI.tamanhoLegivel(p.tamanho);

            item.append(check, texto, tamanho);
            item.addEventListener('click', () => mostrarDetalhe(p));
            lista.appendChild(item);
        });
    }

    /** Mostra as colunas já normalizadas: são os nomes que o autor vai digitar. */
    async function mostrarDetalhe(planilha) {
        planilhaAberta = planilha;
        desenharListaFontes();

        $('detalhe-vazio').style.display = 'none';
        $('detalhe-topo').hidden = false;
        $('detalhe-tabela').hidden = false;
        $('detalhe-titulo').textContent = planilha.nome;
        $('detalhe-info').textContent = 'Lendo...';
        $('detalhe-thead').innerHTML = '';
        $('detalhe-tbody').innerHTML = '';

        try {
            const linhas = await UHN.consultar(planilha.apelido || planilha.nome);
            const colunas = Object.keys(linhas[0] || {});
            const chave = planilha.apelido || planilha.nome;

            $('detalhe-info').textContent =
                linhas.length + ' linhas · ' + colunas.length + ' colunas · use como dados.' + chave;

            const tr = document.createElement('tr');
            colunas.forEach(c => {
                const th = document.createElement('th');
                th.textContent = c;
                tr.appendChild(th);
            });
            $('detalhe-thead').appendChild(tr);

            const corpo = document.createDocumentFragment();
            linhas.slice(0, 60).forEach(linha => {
                const tr = document.createElement('tr');
                colunas.forEach(c => {
                    const td = document.createElement('td');
                    const v = linha[c];
                    td.textContent = (v === null || v === undefined) ? '' : String(v);
                    tr.appendChild(td);
                });
                corpo.appendChild(tr);
            });
            $('detalhe-tbody').appendChild(corpo);
        } catch (err) {
            $('detalhe-info').textContent = err.message;
        }
    }

    function abrirGaveta() {
        $('gaveta').classList.add('aberta');
        $('gaveta').setAttribute('aria-hidden', 'false');
        $('gaveta-fundo').classList.add('aberta');
        // Sempre busca de novo: sincronizarFontes() pode ter preenchido
        // `planilhas` com uma lista já ultrapassada (upload feito em outra aba).
        carregarPlanilhas();
    }

    function fecharGaveta() {
        $('gaveta').classList.remove('aberta');
        $('gaveta').setAttribute('aria-hidden', 'true');
        $('gaveta-fundo').classList.remove('aberta');
    }

    async function carregarPlanilhas() {
        try {
            planilhas = await UHN.listarPlanilhas(true);
            desenharListaFontes();
        } catch (err) {
            UHNUI.aviso(err.message, 'erro');
        }
    }

    // -----------------------------------------------------------------------
    // Rascunho e alterações
    // -----------------------------------------------------------------------
    function instantaneo() {
        return JSON.stringify({
            id: idAtual,
            titulo: $('titulo').value,
            descricao: $('descricao').value,
            fontes: fontes,
            codigo: editor ? editor.getValue() : ''
        });
    }

    function marcarAlteracao() {
        if (!editor) return;
        const atual = instantaneo();
        $('marca-rascunho').classList.toggle('visivel', atual !== salvoRecentemente);
        try { localStorage.setItem(CHAVE_RASCUNHO, atual); } catch { /* modo privado */ }
    }

    async function restaurarRascunho() {
        let bruto;
        try { bruto = localStorage.getItem(CHAVE_RASCUNHO); } catch { return false; }
        if (!bruto) return false;

        let r;
        try { r = JSON.parse(bruto); } catch { return false; }
        if (!r.codigo || r.codigo === codigoInicial()) return false;

        const continuar = await UHNUI.confirmar({
            titulo: 'Rascunho encontrado',
            texto: 'Há um painel não publicado' + (r.titulo ? ' ("' + r.titulo + '")' : '') +
                   '.\nDeseja continuar de onde parou?',
            confirmar: 'Continuar'
        });
        if (!continuar) {
            try { localStorage.removeItem(CHAVE_RASCUNHO); } catch {}
            return false;
        }

        idAtual = r.id || null;
        $('titulo').value = r.titulo || '';
        $('descricao').value = r.descricao || '';
        fontes = Array.isArray(r.fontes) ? r.fontes : [];
        editor.setValue(r.codigo);
        desenharChips();
        marcarAlteracao();
        return true;
    }

    // -----------------------------------------------------------------------
    // Carregar e publicar
    // -----------------------------------------------------------------------
    async function carregarParaEdicao(id) {
        try {
            const resp = await fetch('/api/dashboards/' + encodeURIComponent(id), { credentials: 'same-origin' });
            if (!resp.ok) throw new Error('Painel não encontrado.');
            const d = await resp.json();

            idAtual = d.id;
            $('titulo').value = d.titulo || '';
            $('descricao').value = d.descricao || '';
            fontes = Array.isArray(d.fontes) ? d.fontes.slice() : [];
            editor.setValue(d.codigo || '');

            desenharChips();
            mostrarLinkAbrir(d.id);
            salvoRecentemente = instantaneo();
            marcarAlteracao();

            log('Editando "' + d.titulo + '".');
            executar();
        } catch (err) {
            UHNUI.aviso(err.message, 'erro');
            log(err.message, 'erro');
        }
    }

    function mostrarLinkAbrir(id) {
        const botao = $('btn-abrir');
        botao.href = 'viewer.html?id=' + encodeURIComponent(id);
        botao.hidden = false;
        $('btn-historico').hidden = false;
    }

    async function publicar() {
        const titulo = $('titulo').value.trim();
        if (!titulo) {
            UHNUI.aviso('Dê um nome ao painel antes de publicar.', 'alerta');
            $('titulo').focus();
            return;
        }

        const botao = $('btn-salvar');
        const original = botao.innerHTML;
        botao.disabled = true;
        botao.textContent = 'Publicando...';

        // Garante que o que é salvo reflete o código deste instante, mesmo
        // que o debounce da digitação ainda não tenha rodado.
        await sincronizarFontes();

        try {
            const resp = await fetch('/api/dashboards', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    id: idAtual, titulo,
                    descricao: $('descricao').value.trim(),
                    codigo: editor.getValue(),
                    fontes
                })
            });
            const dados = await resp.json();
            if (!resp.ok) throw new Error(dados.error || 'Falha ao publicar.');

            idAtual = dados.id;
            mostrarLinkAbrir(dados.id);
            salvoRecentemente = instantaneo();
            marcarAlteracao();
            try { localStorage.removeItem(CHAVE_RASCUNHO); } catch {}

            // A URL passa a refletir o que está aberto: recarregar não perde o contexto.
            history.replaceState(null, '', 'index.html?edit=' + encodeURIComponent(dados.id));

            UHNUI.aviso('Publicado! Já está disponível para os usuários.', 'sucesso');
            log('Publicado em /viewer.html?id=' + dados.id, 'ok');
        } catch (err) {
            UHNUI.aviso(err.message, 'erro');
            log(err.message, 'erro');
        } finally {
            botao.disabled = false;
            botao.innerHTML = original;
        }
    }

    // -----------------------------------------------------------------------
    // Modelos
    // -----------------------------------------------------------------------
    function abrirModelos() {
        const lista = $('lista-modelos');
        lista.innerHTML = '';

        modelos().forEach(modelo => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'modelo-item';
            item.innerHTML =
                '<span class="modelo-icone">' + UHNUI.icone(modelo.icone, 17) + '</span>' +
                '<span style="min-width:0">' +
                  '<span style="display:block;font-size:.82rem;font-weight:700">' + UHNUI.escapar(modelo.nome) + '</span>' +
                  '<span style="display:block;font-size:.73rem;color:var(--texto-2);margin-top:.15rem;line-height:1.45">' +
                    UHNUI.escapar(modelo.descricao) + '</span>' +
                '</span>';

            item.addEventListener('click', async () => {
                // O código inicial é um placeholder, não trabalho do autor:
                // pedir confirmação para trocá-lo seria só ruído.
                const atual = editor.getValue().trim();
                const descartavel = !atual || atual === codigoInicial().trim();
                if (!descartavel) {
                    const ok = await UHNUI.confirmar({
                        titulo: 'Substituir o código?',
                        texto: 'O conteúdo atual do editor será trocado pelo modelo.',
                        confirmar: 'Substituir'
                    });
                    if (!ok) return;
                }
                editor.setValue(modelo.codigo);
                $('modelos').style.display = 'none';
                executar();
            });
            lista.appendChild(item);
        });

        $('modelos').style.display = 'grid';
    }

    // -----------------------------------------------------------------------
    // Histórico de versões
    // -----------------------------------------------------------------------
    async function abrirHistorico() {
        if (!idAtual) return;
        const lista = $('lista-historico');
        lista.innerHTML = '<p style="color:var(--texto-2);font-size:.83rem">Carregando...</p>';
        $('historico').style.display = 'grid';

        try {
            const resp = await fetch('/api/dashboards/' + encodeURIComponent(idAtual) + '/versoes', {
                credentials: 'same-origin'
            });
            if (!resp.ok) throw new Error('Não foi possível carregar o histórico.');
            const versoes = await resp.json();

            lista.innerHTML = '';
            if (!versoes.length) {
                lista.innerHTML = '<p style="color:var(--texto-2);font-size:.83rem">' +
                    'Ainda não há versões anteriores salvas. Elas aparecem aqui a cada vez que você publicar uma mudança no código.</p>';
                return;
            }

            versoes.forEach((v, indice) => {
                const quando = v.atualizadoEm
                    ? new Date(v.atualizadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
                    : 'data desconhecida';

                const item = document.createElement('div');
                item.className = 'modelo-item';
                item.style.cursor = 'default';
                item.innerHTML =
                    '<span style="min-width:0;flex:1">' +
                      '<span style="display:block;font-size:.82rem;font-weight:700">' + UHNUI.escapar(quando) + '</span>' +
                      '<span style="display:block;font-size:.73rem;color:var(--texto-2);margin-top:.15rem">' +
                        (v.atualizadoPor && v.atualizadoPor.nome
                          ? 'Publicado por ' + UHNUI.escapar(v.atualizadoPor.nome)
                          : 'Autor desconhecido') +
                      '</span>' +
                    '</span>';

                const botao = document.createElement('button');
                botao.type = 'button';
                botao.className = 'btn btn-contorno';
                botao.style.flexShrink = '0';
                botao.textContent = 'Restaurar';
                botao.addEventListener('click', () => restaurarVersao(indice, quando));
                item.appendChild(botao);

                lista.appendChild(item);
            });
        } catch (err) {
            lista.innerHTML = '';
            UHNUI.aviso(err.message, 'erro');
        }
    }

    async function restaurarVersao(indice, quando) {
        const ok = await UHNUI.confirmar({
            titulo: 'Restaurar esta versão?',
            texto: 'O código de ' + quando + ' volta a ser o publicado. A versão atual não se perde — ela também fica guardada no histórico.',
            confirmar: 'Restaurar'
        });
        if (!ok) return;

        try {
            const resp = await fetch('/api/dashboards/' + encodeURIComponent(idAtual) + '/restaurar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ indice })
            });
            const dados = await resp.json();
            if (!resp.ok) throw new Error(dados.error || 'Não foi possível restaurar essa versão.');

            $('historico').style.display = 'none';
            await carregarParaEdicao(idAtual);
            UHNUI.aviso('Versão restaurada e publicada.', 'sucesso');
        } catch (err) {
            UHNUI.aviso(err.message, 'erro');
        }
    }

    // -----------------------------------------------------------------------
    // Divisor
    // -----------------------------------------------------------------------
    function ativarDivisor() {
        const divisor = $('divisor'), painel = $('painel-codigo'), area = $('area');
        let arrastando = false;

        divisor.addEventListener('mousedown', e => {
            arrastando = true;
            divisor.classList.add('arrastando');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        window.addEventListener('mousemove', e => {
            if (!arrastando) return;
            const r = area.getBoundingClientRect();
            // 20%-80%: nenhum lado pode ser espremido a ponto de ficar inútil
            painel.style.width = Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width)) * 100 + '%';
        });

        window.addEventListener('mouseup', () => {
            if (!arrastando) return;
            arrastando = false;
            divisor.classList.remove('arrastando');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            if (editor) editor.layout();
        });
    }

    /**
     * Sugere os nomes de coluna das fontes em uso sempre que o admin digita.
     * Não é ciente de tipo (Monaco não sabe que `l` é uma linha de dados.P21) —
     * é uma lista simples somada às sugestões normais do JavaScript, o que já
     * cobre o caso comum de esquecer o nome exato de uma coluna normalizada.
     */
    function registrarAutocompleteDeColunas() {
        monaco.languages.registerCompletionItemProvider('javascript', {
            triggerCharacters: ['.', '"', "'"],
            provideCompletionItems(model, position) {
                if (!colunasConhecidas.length) return { suggestions: [] };

                const palavra = model.getWordUntilPosition(position);
                const alcance = {
                    startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
                    startColumn: palavra.startColumn, endColumn: palavra.endColumn
                };
                return {
                    suggestions: colunasConhecidas.map(coluna => ({
                        label: coluna,
                        kind: monaco.languages.CompletionItemKind.Field,
                        detail: 'coluna da planilha',
                        insertText: coluna,
                        range: alcance
                    }))
                };
            }
        });
    }

    // -----------------------------------------------------------------------
    // Inicialização
    // -----------------------------------------------------------------------
    function iniciarMonaco() {
        require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.46.0/min/vs' } });

        require(['vs/editor/editor.main'], async () => {
            editor = monaco.editor.create($('editor'), {
                value: codigoInicial(),
                language: 'javascript',
                theme: 'vs',
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
                fontLigatures: true,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                padding: { top: 14, bottom: 14 },
                renderLineHighlight: 'line',
                smoothScrolling: true,
                tabSize: 2
            });

            // O código roda como corpo de uma async function: `await` no topo é válido.
            monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
                noSemanticValidation: true,
                noSyntaxValidation: false
            });

            registrarAutocompleteDeColunas();

            editor.onDidChangeModelContent(() => { marcarAlteracao(); agendarSincronizarFontes(); });
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, executar);
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, publicar);

            const id = new URLSearchParams(location.search).get('edit');
            if (id) await carregarParaEdicao(id);
            else if (!await restaurarRascunho()) salvoRecentemente = instantaneo();

            log('Editor pronto. Ctrl+Enter executa, Ctrl+S publica.', 'ok');
        });
    }

    function ligarEventos() {
        $('btn-executar').addEventListener('click', executar);
        $('btn-salvar').addEventListener('click', publicar);
        $('btn-escolher-fontes').addEventListener('click', abrirGaveta);
        $('btn-fechar-gaveta').addEventListener('click', fecharGaveta);
        $('gaveta-fundo').addEventListener('click', fecharGaveta);
        $('busca-fontes').addEventListener('input', desenharListaFontes);

        $('titulo').addEventListener('input', marcarAlteracao);
        $('descricao').addEventListener('input', marcarAlteracao);

        $('btn-console').addEventListener('click', () => {
            const visivel = $('console').classList.toggle('visivel');
            $('btn-console').classList.toggle('ligado', visivel);
            if (editor) editor.layout();
        });
        $('btn-limpar-console').addEventListener('click', () => { $('console-linhas').innerHTML = ''; });

        $('btn-modelos').addEventListener('click', abrirModelos);
        $('btn-fechar-modelos').addEventListener('click', () => { $('modelos').style.display = 'none'; });
        $('modelos').addEventListener('click', e => {
            if (e.target === $('modelos')) $('modelos').style.display = 'none';
        });

        $('btn-historico').addEventListener('click', abrirHistorico);
        $('btn-fechar-historico').addEventListener('click', () => { $('historico').style.display = 'none'; });
        $('historico').addEventListener('click', e => {
            if (e.target === $('historico')) $('historico').style.display = 'none';
        });

        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); publicar(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); executar(); }
            if (e.key === 'Escape') { fecharGaveta(); $('modelos').style.display = 'none'; $('historico').style.display = 'none'; }
        });

        window.addEventListener('beforeunload', e => {
            if (editor && instantaneo() !== salvoRecentemente) { e.preventDefault(); e.returnValue = ''; }
        });
    }

    (async function iniciar() {
        usuario = await UHNUI.montarBarraLateral('editor');
        if (!usuario) return;

        // O editor é ferramenta de administrador; o servidor já recusa, mas
        // deixar a tela aberta só produziria erro no momento de publicar.
        if (usuario.papel !== 'admin') {
            document.body.innerHTML =
                '<div class="vazio" style="height:100vh">' +
                  '<div class="vazio-icone">' + UHNUI.icone('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>', 24) + '</div>' +
                  '<h3>Acesso restrito</h3>' +
                  '<p>Somente administradores criam painéis. ' +
                     '<a href="lista_dashboards.html" style="color:var(--azul-600)">Ver os painéis publicados</a>.</p>' +
                '</div>';
            return;
        }

        desenharChips();
        ativarDivisor();
        ligarEventos();
        iniciarMonaco();
        carregarPlanilhas();
    })();
})();
