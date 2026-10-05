/**
 * UHN Runtime - motor de dados dos dashboards.
 * ---------------------------------------------------------------------------
 * Os dados vêm da pasta ./planilhas do próprio sistema, servida em
 * /api/planilhas. Não há mais integração com serviço externo.
 *
 * Duas formas de usar, ambas válidas:
 *
 *   1. Fontes declaradas no editor (recomendado)
 *      O dashboard escolhe as planilhas num seletor; elas chegam prontas:
 *          const linhas = dados.P21;
 *
 *   2. Consulta direta no código (continua funcionando)
 *          const linhas = await consultar('P21');
 *
 * Expõe globalmente: consultar(), dados, UHN
 */
(function (global) {
    'use strict';

    const CONFIG = Object.assign({ apiBase: '/api/planilhas' }, global.UHN_CONFIG || {});

    // Um dashboard consulta a mesma planilha em vários painéis; o cache evita
    // reprocessar o mesmo .xlsx (às vezes alguns MB) a cada uso.
    const cacheLinhas = new Map();
    let cacheIndice = null;

    // ----------------------------------------------------------------------
    // Acesso aos arquivos
    // ----------------------------------------------------------------------

    async function listarPlanilhas(forcar) {
        if (cacheIndice && !forcar) return cacheIndice;
        const resp = await fetch(CONFIG.apiBase, { credentials: 'same-origin' });
        if (resp.status === 401) throw new Error('Sessão expirada. Recarregue a página para entrar de novo.');
        if (!resp.ok) throw new Error('Não foi possível listar as planilhas (HTTP ' + resp.status + ').');
        const lista = await resp.json();
        cacheIndice = lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
        return cacheIndice;
    }

    async function baixar(nome) {
        const resp = await fetch(CONFIG.apiBase + '/' + encodeURIComponent(nome), { credentials: 'same-origin' });
        if (!resp.ok) throw new Error('Falha ao ler "' + nome + '" (HTTP ' + resp.status + ').');
        return resp.arrayBuffer();
    }

    /**
     * Envia uma planilha para o servidor.
     *
     * Usa XMLHttpRequest em vez de fetch porque só ele reporta o progresso do
     * UPLOAD. Com arquivos de dezenas de MB, a diferença entre uma barra que
     * anda e uma tela parada é a diferença entre esperar e achar que travou.
     *
     * `aoProgresso` recebe { enviados, total, porcentagem } enquanto sobe.
     */
    function enviarPlanilha(nome, conteudo, aoProgresso) {
        return new Promise((resolver, rejeitar) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', CONFIG.apiBase + '/' + encodeURIComponent(nome));
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.withCredentials = true;

            if (typeof aoProgresso === 'function') {
                xhr.upload.onprogress = ev => {
                    if (!ev.lengthComputable) return;
                    aoProgresso({
                        enviados: ev.loaded,
                        total: ev.total,
                        porcentagem: (ev.loaded / ev.total) * 100
                    });
                };
            }

            xhr.onload = () => {
                let corpo = {};
                try { corpo = JSON.parse(xhr.responseText); } catch { /* resposta sem JSON */ }
                if (xhr.status >= 200 && xhr.status < 300) {
                    if (typeof aoProgresso === 'function') {
                        aoProgresso({ enviados: 1, total: 1, porcentagem: 100 });
                    }
                    resolver(corpo);
                } else {
                    rejeitar(new Error(corpo.error || 'HTTP ' + xhr.status));
                }
            };
            xhr.onerror = () => rejeitar(new Error('Falha de rede ao enviar.'));
            xhr.onabort = () => rejeitar(new Error('Envio cancelado.'));

            xhr.send(conteudo);
        });
    }

    // ----------------------------------------------------------------------
    // Normalização
    // ----------------------------------------------------------------------

    /** "Avanço Físico (%)" -> "avanco_fisico" */
    function normalizarChave(chave) {
        return String(chave).trim().toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '') || 'col';
    }

    function normalizarLinha(linha) {
        const saida = {};
        for (const [chave, valor] of Object.entries(linha)) saida[normalizarChave(chave)] = valor;
        return saida;
    }

    // ----------------------------------------------------------------------
    // Resolução de nomes
    // ----------------------------------------------------------------------

    /**
     * Aceita 'P21', 'planilha_21', '21' ou o nome completo do arquivo.
     * Os arquivos reais variam o separador depois do número
     * ("P21-Planejamento..." e "P22 - Planejamento..."), então testamos todas
     * as formas. Exigir um separador evita que 'P2' case com 'P21'.
     */
    function resolverArquivo(alvo, arquivos) {
        const bruto = String(alvo).trim();
        const nomes = arquivos.map(f => f.nome);

        const exato = nomes.find(n => n.toLowerCase() === bruto.toLowerCase());
        if (exato) return exato;

        const num = bruto.match(/(\d+)/);
        if (num) {
            const variantes = [...new Set([num[1], String(Number(num[1]))])];
            const prefixos = [];
            for (const v of variantes) {
                for (const s of ['-', ' ', '_', '.']) prefixos.push('p' + v + s, v + s);
            }
            const achado = nomes.find(nome => {
                const baixo = nome.toLowerCase().trim();
                if (prefixos.some(p => baixo.startsWith(p))) return true;
                return variantes.some(v => ['p' + v + '.xlsx', 'p' + v + '.xls', v + '.xlsx', v + '.xls'].includes(baixo));
            });
            if (achado) return achado;
        }

        return nomes.find(n => n.toLowerCase().includes(bruto.toLowerCase())) || null;
    }

    // ----------------------------------------------------------------------
    // Consulta
    // ----------------------------------------------------------------------

    /**
     * Descobre em qual linha está o cabeçalho.
     * Procura, entre as primeiras linhas, a primeira que esteja pelo menos 80%
     * tão preenchida quanto a mais preenchida de todas. Uma linha de título
     * solta tem 1 ou 2 células e fica de fora; o cabeçalho de verdade, que é a
     * linha mais completa da região, é escolhido mesmo vindo depois.
     */
    function detectarCabecalho(matriz) {
        const limite = Math.min(12, matriz.length);
        const preenchidas = [];
        for (let i = 0; i < limite; i++) {
            preenchidas.push((matriz[i] || [])
                .filter(c => c !== null && c !== undefined && String(c).trim() !== '').length);
        }
        const maximo = Math.max(...preenchidas, 0);
        if (maximo === 0) return 0;
        const corte = maximo * 0.8;
        const achado = preenchidas.findIndex(n => n >= corte);
        return achado >= 0 ? achado : 0;
    }

    /**
     * Lê uma planilha e devolve as linhas com as colunas normalizadas.
     * Aceita o atalho `consultar('P21')` ou o SQL simplificado antigo
     * `consultar('SELECT * FROM "planilha_21"')`.
     *
     * Em caso de erro lança exceção com mensagem útil. Devolver [] em silêncio
     * (comportamento antigo) escondia a causa e o painel aparecia vazio sem
     * explicação nenhuma.
     */
    async function consultar(query) {
        const texto = String(query || '').trim();
        if (!texto) throw new Error('consultar(): informe a planilha. Ex.: consultar("P21")');

        const m = texto.match(/FROM\s+["'`]?([^"'`\s]+(?:[^"'`]*[^"'`\s])?)["'`]?/i);
        const alvo = m ? m[1].trim() : texto;

        if (cacheLinhas.has(alvo)) return cacheLinhas.get(alvo);

        const arquivos = await listarPlanilhas();
        if (!arquivos.length) {
            throw new Error('Nenhuma planilha disponível. Envie os arquivos pelo editor.');
        }

        const arquivo = resolverArquivo(alvo, arquivos);
        if (!arquivo) {
            throw new Error('Planilha "' + alvo + '" não encontrada. Disponíveis: ' +
                arquivos.slice(0, 6).map(f => f.apelido || f.nome).join(', ') +
                (arquivos.length > 6 ? ' ...e mais ' + (arquivos.length - 6) : ''));
        }

        if (typeof global.XLSX === 'undefined') throw new Error('Biblioteca XLSX não carregada.');

        const wb = global.XLSX.read(await baixar(arquivo), { type: 'array', cellDates: true });
        const aba = wb.Sheets[wb.SheetNames[0]];

        // Muitas planilhas da obra trazem um título mesclado na primeira linha;
        // o cabeçalho real vem abaixo. Ler sempre a linha 0 devolveria colunas
        // __EMPTY e a planilha inteira ficaria inutilizável.
        const matriz = global.XLSX.utils.sheet_to_json(aba, { header: 1, defval: null });
        const linhaCabecalho = detectarCabecalho(matriz);

        const linhas = global.XLSX.utils
            .sheet_to_json(aba, { defval: null, range: linhaCabecalho })
            .map(normalizarLinha);

        cacheLinhas.set(alvo, linhas);
        return linhas;
    }

    /**
     * Carrega de uma vez as fontes declaradas no editor e devolve um objeto
     * indexado pelo apelido: { P21: [...], P22: [...] }.
     * As falhas não interrompem as demais — cada fonte que falhar vira [] e a
     * mensagem fica em `dados._erros` para o dashboard decidir o que mostrar.
     */
    async function carregarFontes(fontes) {
        const saida = { _erros: {} };
        if (!Array.isArray(fontes) || !fontes.length) return saida;

        await Promise.all(fontes.map(async fonte => {
            const chave = String(fonte).replace(/[^A-Za-z0-9_]/g, '_');
            try {
                saida[chave] = await consultar(fonte);
            } catch (err) {
                saida[chave] = [];
                saida._erros[chave] = err.message;
            }
        }));
        return saida;
    }

    function limparCache() {
        cacheLinhas.clear();
        cacheIndice = null;
    }

    // -----------------------------------------------------------------------
    // Resolução de coluna com sugestão de grafia
    // -----------------------------------------------------------------------

    /** Distância de edição entre duas strings curtas (programação dinâmica O(n·m)). */
    function distanciaLevenshtein(a, b) {
        const linhas = a.length + 1, colunasN = b.length + 1;
        const d = Array.from({ length: linhas }, (_, i) => [i, ...Array(colunasN - 1).fill(0)]);
        for (let j = 0; j < colunasN; j++) d[0][j] = j;
        for (let i = 1; i < linhas; i++) {
            for (let j = 1; j < colunasN; j++) {
                const custo = a[i - 1] === b[j - 1] ? 0 : 1;
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + custo);
            }
        }
        return d[linhas - 1][colunasN - 1];
    }

    const avisosColunaEmitidos = new Set();   // evita repetir o mesmo aviso a cada linha processada

    /**
     * Acha a coluna real a partir de nomes candidatos (o primeiro que bater
     * vence). Se nenhum bater, avisa uma vez no console qual coluna existente
     * é a mais parecida com o primeiro candidato — para um erro de grafia não
     * exigir reabrir a planilha para descobrir o nome certo.
     */
    function coluna(linhas, ...candidatos) {
        if (!linhas || !linhas.length) return null;
        const existentes = new Map();
        for (const chave of Object.keys(linhas[0])) existentes.set(normalizarChave(chave), chave);

        for (const candidato of candidatos) {
            const n = normalizarChave(candidato);
            if (existentes.has(n)) return existentes.get(n);
        }

        const alvo = normalizarChave(candidatos[0] || '');
        if (!alvo) return null;

        const chaveAviso = alvo + '|' + [...existentes.keys()].sort().join(',');
        if (avisosColunaEmitidos.has(chaveAviso)) return null;

        let melhor = null, menorDistancia = Infinity;
        for (const chaveNormalizada of existentes.keys()) {
            const d = distanciaLevenshtein(alvo, chaveNormalizada);
            if (d < menorDistancia) { menorDistancia = d; melhor = chaveNormalizada; }
        }
        // Tolerância proporcional ao tamanho do nome: nomes curtos toleram
        // pouca diferença, nomes longos toleram mais erros de digitação.
        const tolerancia = Math.max(2, Math.ceil(alvo.length * 0.34));
        if (melhor && menorDistancia > 0 && menorDistancia <= tolerancia) {
            console.warn('Coluna "' + candidatos[0] + '" não encontrada. Você quis dizer "' +
                existentes.get(melhor) + '"?');
        }
        avisosColunaEmitidos.add(chaveAviso);
        return null;
    }

    global.consultar = consultar;
    global.UHN = {
        consultar, carregarFontes, listarPlanilhas, enviarPlanilha,
        limparCache, normalizarChave, resolverArquivo, coluna, config: CONFIG
    };
})(window);
