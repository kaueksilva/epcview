/**
 * Camada de acesso ao database.json
 * ---------------------------------------------------------------------------
 * Um arquivo JSON é o banco do sistema: usuários e dashboards. As sessões
 * ficam num arquivo à parte, fora do controle de versão.
 * Para o porte do UHNIntegra (uma obra, dezenas de usuários) isso é suficiente
 * e mantém o deploy em "copiar a pasta e rodar node".
 *
 * Dois cuidados que um arquivo único exige:
 *   - Escrita atômica: grava num .tmp e renomeia. Um `rename` no mesmo volume
 *     é atômico, então nunca sobra um database.json truncado se o processo cair
 *     no meio da escrita.
 *   - Fila de escrita: as gravações são serializadas numa promise encadeada,
 *     para dois pedidos simultâneos não se sobrescreverem.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// Sobrepostos pelo teste automatizado (test/*.test.js), pra nunca ler/gravar o
// banco de desenvolvimento de verdade — sem isso os testes de grupo/usuário
// apagariam ou poluiriam data/database.json a cada execução.
const ARQUIVO = process.env.UHN_DB_ARQUIVO || path.join(__dirname, '..', 'data', 'database.json');

/**
 * As sessoes ficam FORA do database.json de proposito.
 * Um token de sessao e uma credencial viva: quem o tem entra sem senha. Se as
 * sessoes morassem no arquivo versionado, cada login sujaria o git e, pior,
 * publicaria tokens validos no repositorio.
 */
const ARQUIVO_SESSOES = process.env.UHN_DB_ARQUIVO_SESSOES || path.join(__dirname, '..', 'data', 'sessoes.json');

const ESTRUTURA_INICIAL = {
    versao: 2,
    usuarios: [],
    dashboards: [],
    grupos: []
};

let cache = null;
let cacheSessoes = null;
let filaEscrita = Promise.resolve();
let filaSessoes = Promise.resolve();

// ---------------------------------------------------------------------------
// Leitura e escrita
// ---------------------------------------------------------------------------

function carregar() {
    if (cache) return cache;
    try {
        const bruto = fs.readFileSync(ARQUIVO, 'utf8');
        const dados = JSON.parse(bruto);
        // Garante todas as coleções mesmo num arquivo antigo ou editado à mão.
        cache = Object.assign({}, ESTRUTURA_INICIAL, dados);
        delete cache.sessoes;   // migração da v1: sessões saíram deste arquivo
        for (const chave of ['usuarios', 'dashboards', 'grupos']) {
            if (!Array.isArray(cache[chave])) cache[chave] = [];
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('[db] database.json ilegível: ' + err.message);
            console.error('[db] iniciando um banco vazio; o arquivo anterior NÃO foi apagado.');
        }
        cache = JSON.parse(JSON.stringify(ESTRUTURA_INICIAL));
    }
    migrarParaGrupos();
    return cache;
}

/**
 * Grupo substituiu papel: usuário não escolhe mais "admin"/"visualizador" direto,
 * é o grupo que carrega isso agora (grupo.admin). Quem já existia de antes do
 * recurso (usuario.papel gravado, sem grupoId) cai num grupo criado na hora —
 * "Administradores" ou "Visualizadores" — preservando o acesso que já tinha.
 */
function migrarParaGrupos() {
    let grupoAdmin = cache.grupos.find(g => g.admin);
    let grupoPadrao = null;
    let mudou = false;

    cache.usuarios.forEach(usuario => {
        const grupoValido = usuario.grupoId && cache.grupos.some(g => g.id === usuario.grupoId);
        if (grupoValido) {
            if (usuario.papel !== undefined) { delete usuario.papel; mudou = true; }
            return;
        }

        const agora = new Date().toISOString();
        if (usuario.papel === 'admin') {
            if (!grupoAdmin) {
                grupoAdmin = { id: novoId(), nome: 'Administradores', admin: true,
                    paginas: PAGINAS_CONTROLAVEIS.slice(), dashboards: 'todos', aplicacoes: 'todos',
                    criadoEm: agora, atualizadoEm: agora };
                cache.grupos.push(grupoAdmin);
            }
            usuario.grupoId = grupoAdmin.id;
        } else {
            if (!grupoPadrao) {
                grupoPadrao = { id: novoId(), nome: 'Visualizadores', admin: false,
                    paginas: PAGINAS_CONTROLAVEIS.slice(), dashboards: 'todos', aplicacoes: [],
                    criadoEm: agora, atualizadoEm: agora };
                cache.grupos.push(grupoPadrao);
            }
            usuario.grupoId = grupoPadrao.id;
        }
        delete usuario.papel;
        mudou = true;
    });

    if (mudou) salvar();
}

/** Enfileira a gravação; o retorno resolve quando os dados estão no disco. */
function salvar() {
    const conteudo = JSON.stringify(cache, null, 2);
    filaEscrita = filaEscrita.then(async () => {
        await fsp.mkdir(path.dirname(ARQUIVO), { recursive: true });
        const temporario = ARQUIVO + '.tmp';
        await fsp.writeFile(temporario, conteudo, 'utf8');
        await fsp.rename(temporario, ARQUIVO);   // atômico
    }).catch(err => {
        console.error('[db] falha ao gravar: ' + err.message);
    });
    return filaEscrita;
}

// --- sessões (arquivo separado, nunca versionado) ---

let cacheAcessos = null;

function carregarSessoes() {
    if (cacheSessoes) return cacheSessoes;
    try {
        const dados = JSON.parse(fs.readFileSync(ARQUIVO_SESSOES, 'utf8'));
        cacheSessoes = Array.isArray(dados.sessoes) ? dados.sessoes : [];
        cacheAcessos = (dados.acessos && typeof dados.acessos === 'object') ? dados.acessos : {};
    } catch {
        cacheSessoes = [];   // arquivo ausente ou ilegivel: comeca vazio
        cacheAcessos = {};
    }
    return cacheSessoes;
}

/** Ultimo acesso por usuario, guardado junto das sessoes (fora do git). */
function registrarAcesso(usuarioId, quando) {
    carregarSessoes();
    cacheAcessos[usuarioId] = quando;
}

function ultimoAcessoDe(usuarioId) {
    carregarSessoes();
    return cacheAcessos[usuarioId] || null;
}

function salvarSessoes() {
    const conteudo = JSON.stringify({ sessoes: cacheSessoes, acessos: cacheAcessos || {} }, null, 2);
    filaSessoes = filaSessoes.then(async () => {
        await fsp.mkdir(path.dirname(ARQUIVO_SESSOES), { recursive: true });
        const temporario = ARQUIVO_SESSOES + '.tmp';
        await fsp.writeFile(temporario, conteudo, 'utf8');
        await fsp.rename(temporario, ARQUIVO_SESSOES);
    }).catch(err => console.error('[db] falha ao gravar sessões: ' + err.message));
    return filaSessoes;
}

// ---------------------------------------------------------------------------
// Senhas
// ---------------------------------------------------------------------------

/**
 * scrypt é a função de derivação recomendada e vem no Node, sem dependência.
 * Guardamos "salt:hash" — o salt é único por usuário, então duas senhas iguais
 * geram hashes diferentes.
 */
function gerarHashSenha(senha) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(senha), salt, 64).toString('hex');
    return salt + ':' + hash;
}

function conferirSenha(senha, armazenado) {
    try {
        const [salt, hash] = String(armazenado).split(':');
        if (!salt || !hash) return false;
        const tentativa = crypto.scryptSync(String(senha), salt, 64);
        const guardado = Buffer.from(hash, 'hex');
        if (tentativa.length !== guardado.length) return false;
        // timingSafeEqual evita vazar informação pelo tempo de comparação
        return crypto.timingSafeEqual(tentativa, guardado);
    } catch {
        return false;
    }
}

function novoId() {
    return crypto.randomBytes(9).toString('hex');
}

// ---------------------------------------------------------------------------
// Usuários
// ---------------------------------------------------------------------------

// Páginas que um grupo pode liberar ou não para um visualizador. Editor,
// Usuários e Dockers continuam exclusivos de admin, grupo nenhum muda isso.
const PAGINAS_CONTROLAVEIS = ['galeria', 'planilhas'];

function emailValido(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

/** Quantos usuários resolvem para admin agora, opcionalmente sem contar um usuário/grupo específico. */
function contarAdmins({ semUsuarioId, semGrupoId } = {}) {
    return carregar().usuarios.filter(u => {
        if (u.id === semUsuarioId) return false;
        const grupo = acharGrupo(u.grupoId);
        return grupo && grupo.admin && grupo.id !== semGrupoId;
    }).length;
}

/**
 * Remove o hash da senha e resolve o papel a partir do grupo — não é mais um
 * campo próprio do usuário, é o grupo.admin de quem ele pertence.
 */
function publico(usuario) {
    if (!usuario) return null;
    const { senha, ...resto } = usuario;
    const grupo = acharGrupo(resto.grupoId);
    resto.papel = grupo && grupo.admin ? 'admin' : 'visualizador';
    return resto;
}

function listarUsuarios() {
    return carregar().usuarios.map(u =>
        Object.assign(publico(u), { ultimoAcesso: ultimoAcessoDe(u.id) }));
}

function acharUsuarioPorLogin(login) {
    const alvo = String(login || '').trim().toLowerCase();
    return carregar().usuarios.find(u => u.login.toLowerCase() === alvo) || null;
}

function acharUsuario(id) {
    return carregar().usuarios.find(u => u.id === id) || null;
}

function criarUsuario({ login, nome, senha, email, grupoId }) {
    const db = carregar();
    const limpo = String(login || '').trim().toLowerCase();

    if (!/^[a-z0-9._-]{3,32}$/.test(limpo)) {
        throw Object.assign(new Error('Login deve ter 3 a 32 caracteres (letras, números, ponto, hífen ou _).'), { status: 400 });
    }
    if (acharUsuarioPorLogin(limpo)) {
        throw Object.assign(new Error('Já existe um usuário com esse login.'), { status: 409 });
    }
    if (String(senha || '').length < 6) {
        throw Object.assign(new Error('A senha precisa de pelo menos 6 caracteres.'), { status: 400 });
    }
    const emailLimpo = email ? String(email).trim().toLowerCase() : null;
    if (emailLimpo && !emailValido(emailLimpo)) {
        throw Object.assign(new Error('E-mail inválido.'), { status: 400 });
    }
    // O grupo agora também decide se é admin — todo usuário precisa estar em um.
    if (!acharGrupo(grupoId)) {
        throw Object.assign(new Error('Selecione um grupo para o usuário.'), { status: 400 });
    }

    const usuario = {
        id: novoId(),
        login: limpo,
        nome: String(nome || limpo).trim().slice(0, 80),
        email: emailLimpo,
        grupoId,
        senha: gerarHashSenha(senha),
        criadoEm: new Date().toISOString()
    };
    db.usuarios.push(usuario);
    salvar();
    return publico(usuario);
}

function atualizarUsuario(id, campos) {
    const db = carregar();
    const usuario = db.usuarios.find(u => u.id === id);
    if (!usuario) throw Object.assign(new Error('Usuário não encontrado.'), { status: 404 });

    if (campos.nome !== undefined) usuario.nome = String(campos.nome).trim().slice(0, 80);
    if (campos.email !== undefined) {
        const emailLimpo = campos.email ? String(campos.email).trim().toLowerCase() : null;
        if (emailLimpo && !emailValido(emailLimpo)) {
            throw Object.assign(new Error('E-mail inválido.'), { status: 400 });
        }
        usuario.email = emailLimpo;
    }
    if (campos.grupoId !== undefined && campos.grupoId !== usuario.grupoId) {
        const novoGrupo = acharGrupo(campos.grupoId);
        if (!novoGrupo) throw Object.assign(new Error('Grupo não encontrado.'), { status: 400 });

        // Nunca deixar o sistema sem nenhum admin: se tirar este usuário de um
        // grupo admin, precisa sobrar pelo menos um outro em grupo admin.
        const grupoAtual = acharGrupo(usuario.grupoId);
        if (grupoAtual && grupoAtual.admin && !novoGrupo.admin && contarAdmins({ semUsuarioId: id }) === 0) {
            throw Object.assign(new Error('Este é o único administrador; mova outro usuário para um grupo admin antes.'), { status: 400 });
        }
        usuario.grupoId = campos.grupoId;
    }
    if (campos.senha) {
        if (String(campos.senha).length < 6) {
            throw Object.assign(new Error('A senha precisa de pelo menos 6 caracteres.'), { status: 400 });
        }
        usuario.senha = gerarHashSenha(campos.senha);
        // Trocar a senha derruba as sessões abertas daquele usuário.
        cacheSessoes = carregarSessoes().filter(s => s.usuarioId !== id);
        salvarSessoes();
    }
    salvar();
    return publico(usuario);
}

function removerUsuario(id) {
    const db = carregar();
    const usuario = db.usuarios.find(u => u.id === id);
    if (!usuario) throw Object.assign(new Error('Usuário não encontrado.'), { status: 404 });

    const grupo = acharGrupo(usuario.grupoId);
    if (grupo && grupo.admin && contarAdmins({ semUsuarioId: id }) === 0) {
        throw Object.assign(new Error('Não é possível remover o único administrador.'), { status: 400 });
    }
    db.usuarios = db.usuarios.filter(u => u.id !== id);
    cacheSessoes = carregarSessoes().filter(s => s.usuarioId !== id);
    salvarSessoes();
    salvar();
    return true;
}

// ---------------------------------------------------------------------------
// Grupos — controlam, para quem não é admin, quais páginas, painéis e
// aplicações (Dockers) aparecem. Admin sempre vê tudo, grupo nenhum restringe.
// ---------------------------------------------------------------------------

function listarGrupos() {
    return carregar().grupos.slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

function acharGrupo(id) {
    if (!id) return null;
    return carregar().grupos.find(g => g.id === id) || null;
}

/** 'todos' passa direto; qualquer outra coisa vira lista de ids únicos (nunca null/undefined soltos). */
function normalizarListaOuTodos(valor) {
    if (valor === 'todos') return 'todos';
    if (Array.isArray(valor)) return [...new Set(valor.map(String).filter(Boolean))];
    return [];
}

function criarGrupo({ nome, admin, paginas, dashboards, aplicacoes }) {
    const db = carregar();
    const nomeLimpo = String(nome || '').trim().slice(0, 60);
    if (!nomeLimpo) throw Object.assign(new Error('Dê um nome para o grupo.'), { status: 400 });
    if (db.grupos.some(g => g.nome.toLowerCase() === nomeLimpo.toLowerCase())) {
        throw Object.assign(new Error('Já existe um grupo com esse nome.'), { status: 409 });
    }

    const grupo = {
        id: novoId(),
        nome: nomeLimpo,
        admin: Boolean(admin),
        paginas: Array.isArray(paginas) ? paginas.filter(p => PAGINAS_CONTROLAVEIS.includes(p)) : [],
        dashboards: normalizarListaOuTodos(dashboards),
        aplicacoes: normalizarListaOuTodos(aplicacoes),
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString()
    };
    db.grupos.push(grupo);
    salvar();
    return grupo;
}

function atualizarGrupo(id, campos) {
    const db = carregar();
    const grupo = db.grupos.find(g => g.id === id);
    if (!grupo) throw Object.assign(new Error('Grupo não encontrado.'), { status: 404 });

    if (campos.nome !== undefined) {
        const nomeLimpo = String(campos.nome).trim().slice(0, 60);
        if (!nomeLimpo) throw Object.assign(new Error('Dê um nome para o grupo.'), { status: 400 });
        if (db.grupos.some(g => g.id !== id && g.nome.toLowerCase() === nomeLimpo.toLowerCase())) {
            throw Object.assign(new Error('Já existe um grupo com esse nome.'), { status: 409 });
        }
        grupo.nome = nomeLimpo;
    }
    if (campos.admin !== undefined) {
        const novoAdmin = Boolean(campos.admin);
        // Tirar o "admin" deste grupo só é um problema se alguém aqui dentro
        // realmente perderia o acesso — um grupo admin vazio pode virar comum à vontade.
        const temMembros = db.usuarios.some(u => u.grupoId === id);
        if (grupo.admin && !novoAdmin && temMembros && contarAdmins({ semGrupoId: id }) === 0) {
            throw Object.assign(new Error('Isso deixaria o sistema sem nenhum administrador. Mova os usuários deste grupo para outro grupo admin antes.'), { status: 400 });
        }
        grupo.admin = novoAdmin;
    }
    if (campos.paginas !== undefined) {
        grupo.paginas = Array.isArray(campos.paginas) ? campos.paginas.filter(p => PAGINAS_CONTROLAVEIS.includes(p)) : [];
    }
    if (campos.dashboards !== undefined) grupo.dashboards = normalizarListaOuTodos(campos.dashboards);
    if (campos.aplicacoes !== undefined) grupo.aplicacoes = normalizarListaOuTodos(campos.aplicacoes);
    grupo.atualizadoEm = new Date().toISOString();

    salvar();
    return grupo;
}

function removerGrupo(id) {
    const db = carregar();
    if (!db.grupos.some(g => g.id === id)) {
        throw Object.assign(new Error('Grupo não encontrado.'), { status: 404 });
    }
    // Todo usuário precisa estar em algum grupo — sem para onde mandar os membros,
    // apagar o grupo os deixaria sem papel nenhum. Move primeiro, depois remove.
    const membros = db.usuarios.filter(u => u.grupoId === id).length;
    if (membros > 0) {
        throw Object.assign(new Error('Mova ' + (membros === 1 ? 'o usuário deste grupo' : 'os ' + membros + ' usuários deste grupo') + ' para outro grupo antes de removê-lo.'), { status: 400 });
    }
    db.grupos = db.grupos.filter(g => g.id !== id);
    salvar();
    return true;
}

function contarUsuariosNoGrupo(id) {
    return carregar().usuarios.filter(u => u.grupoId === id).length;
}

/**
 * Resolve o que um usuário pode ver. Admin não passa por grupo (vê tudo);
 * visualizador sem grupo mantém o comportamento de sempre (painéis e
 * planilhas liberados, nenhuma aplicação extra) — o recurso é aditivo,
 * não pode trancar quem já usava o sistema antes dele existir.
 */
function permissoesDoUsuario(usuario) {
    if (!usuario) return { paginas: [], dashboards: [], aplicacoes: [] };
    if (usuario.papel === 'admin') return { paginas: 'todos', dashboards: 'todos', aplicacoes: 'todos' };

    const grupo = acharGrupo(usuario.grupoId);
    if (!grupo) return { paginas: PAGINAS_CONTROLAVEIS.slice(), dashboards: 'todos', aplicacoes: [] };
    return { paginas: grupo.paginas.slice(), dashboards: grupo.dashboards, aplicacoes: grupo.aplicacoes };
}

// ---------------------------------------------------------------------------
// Sessões
// ---------------------------------------------------------------------------

const DURACAO_SESSAO_MS = 12 * 60 * 60 * 1000;   // 12 h: um turno de trabalho

function limparSessoesVencidas() {
    const sessoes = carregarSessoes();
    const agora = Date.now();
    const antes = sessoes.length;
    cacheSessoes = sessoes.filter(s => new Date(s.expiraEm).getTime() > agora);
    if (cacheSessoes.length !== antes) salvarSessoes();
}

/** Invalida todas as sessões abertas. Usado quando um token pode ter vazado. */
function encerrarTodasSessoes() {
    cacheSessoes = [];
    return salvarSessoes();
}

function autenticar(login, senha) {
    const usuario = acharUsuarioPorLogin(login);
    // Mesmo sem usuário, gastamos tempo derivando a senha: assim o tempo de
    // resposta não denuncia quais logins existem.
    const referencia = usuario ? usuario.senha : gerarHashSenha('senha-inexistente');
    if (!conferirSenha(senha, referencia) || !usuario) return null;

    const sessao = {
        token: crypto.randomBytes(32).toString('hex'),
        usuarioId: usuario.id,
        criadaEm: new Date().toISOString(),
        expiraEm: new Date(Date.now() + DURACAO_SESSAO_MS).toISOString()
    };
    carregarSessoes().push(sessao);
    registrarAcesso(usuario.id, sessao.criadaEm);
    salvarSessoes();

    // O ultimo acesso NAO entra no database.json: ele e versionado, e gravar
    // um carimbo de hora a cada login sujava o git com um commit de ruido.
    return { token: sessao.token, usuario: publico(usuario) };
}

function usuarioDaSessao(token) {
    if (!token) return null;
    const sessao = carregarSessoes().find(s => s.token === token);
    if (!sessao) return null;
    if (new Date(sessao.expiraEm).getTime() <= Date.now()) {
        cacheSessoes = carregarSessoes().filter(s => s.token !== token);
        salvarSessoes();
        return null;
    }
    return publico(acharUsuario(sessao.usuarioId));
}

function encerrarSessao(token) {
    const sessoes = carregarSessoes();
    const antes = sessoes.length;
    cacheSessoes = sessoes.filter(s => s.token !== token);
    if (cacheSessoes.length !== antes) salvarSessoes();
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

function listarDashboards() {
    return carregar().dashboards
        .map(d => ({
            id: d.id, titulo: d.titulo, descricao: d.descricao,
            fontes: d.fontes || [], autor: d.autor || null,
            criadoEm: d.criadoEm, atualizadoEm: d.atualizadoEm,
            tamanhoCodigo: (d.codigo || '').length
        }))
        .sort((a, b) => String(b.atualizadoEm || '').localeCompare(String(a.atualizadoEm || '')));
}

function acharDashboard(id) {
    return carregar().dashboards.find(d => d.id === id) || null;
}

function gerarSlug(titulo) {
    const base = String(titulo || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 60) || 'dashboard';

    const db = carregar();
    let candidato = base, n = 2;
    while (db.dashboards.some(d => d.id === candidato)) candidato = base + '-' + (n++);
    return candidato;
}

const MAX_VERSOES = 15; // histórico é uma rede de segurança, não um repositório git

function salvarDashboard({ id, titulo, descricao, codigo, fontes }, autor) {
    const db = carregar();
    const nome = String(titulo || '').trim();
    if (!nome) throw Object.assign(new Error('Informe um título para o dashboard.'), { status: 400 });

    const agora = new Date().toISOString();
    const existente = id ? db.dashboards.find(d => d.id === id) : null;
    const codigoNovo = typeof codigo === 'string' ? codigo : '';

    // Só entra uma versão nova no histórico se o código de fato mudou — salvar
    // sem editar nada não deveria empurrar histórico útil para fora da pilha.
    let versoes = existente ? (existente.versoes || []) : [];
    if (existente && existente.codigo !== codigoNovo) {
        versoes = [{
            codigo: existente.codigo,
            fontes: existente.fontes || [],
            descricao: existente.descricao || '',
            atualizadoEm: existente.atualizadoEm,
            atualizadoPor: existente.atualizadoPor || null
        }, ...versoes].slice(0, MAX_VERSOES);
    }

    const registro = {
        id: existente ? existente.id : gerarSlug(nome),
        titulo: nome,
        descricao: String(descricao || '').trim().slice(0, 240),
        codigo: codigoNovo,
        fontes: Array.isArray(fontes) ? fontes.filter(f => typeof f === 'string').slice(0, 40) : [],
        autor: existente ? existente.autor : (autor ? { id: autor.id, nome: autor.nome } : null),
        atualizadoPor: autor ? { id: autor.id, nome: autor.nome } : null,
        criadoEm: existente ? existente.criadoEm : agora,
        atualizadoEm: agora,
        versoes
    };

    if (existente) Object.assign(existente, registro);
    else db.dashboards.push(registro);

    salvar();
    return registro;
}

/** Lista o histórico de um dashboard, sem o código (só o cabeçalho de cada versão). */
function listarVersoes(id) {
    const dashboard = acharDashboard(id);
    if (!dashboard) throw Object.assign(new Error('Dashboard não encontrado.'), { status: 404 });
    return (dashboard.versoes || []).map((v, indice) => ({
        indice, descricao: v.descricao, fontes: v.fontes || [],
        atualizadoEm: v.atualizadoEm, atualizadoPor: v.atualizadoPor,
        tamanhoCodigo: (v.codigo || '').length
    }));
}

/**
 * Restaura uma versão antiga como a atual. O que estava valendo até agora
 * também vira uma entrada no histórico — restaurar nunca é uma via sem volta.
 */
function restaurarVersao(id, indice, autor) {
    const db = carregar();
    const dashboard = db.dashboards.find(d => d.id === id);
    if (!dashboard) throw Object.assign(new Error('Dashboard não encontrado.'), { status: 404 });

    const versoes = dashboard.versoes || [];
    const alvo = versoes[indice];
    if (!alvo) throw Object.assign(new Error('Versão não encontrada.'), { status: 404 });

    const agora = new Date().toISOString();
    const historicoAtualizado = [{
        codigo: dashboard.codigo, fontes: dashboard.fontes || [], descricao: dashboard.descricao || '',
        atualizadoEm: dashboard.atualizadoEm, atualizadoPor: dashboard.atualizadoPor || null
    }, ...versoes.filter((_, i) => i !== indice)].slice(0, MAX_VERSOES);

    dashboard.codigo = alvo.codigo;
    dashboard.fontes = alvo.fontes || [];
    dashboard.atualizadoEm = agora;
    dashboard.atualizadoPor = autor ? { id: autor.id, nome: autor.nome } : null;
    dashboard.versoes = historicoAtualizado;

    salvar();
    return dashboard;
}

/** Cria uma cópia independente — a nova instância começa sem histórico próprio. */
function duplicarDashboard(id, autor) {
    const original = acharDashboard(id);
    if (!original) throw Object.assign(new Error('Dashboard não encontrado.'), { status: 404 });

    const db = carregar();
    const agora = new Date().toISOString();
    const copia = {
        id: gerarSlug(original.titulo + ' (cópia)'),
        titulo: original.titulo + ' (cópia)',
        descricao: original.descricao || '',
        codigo: original.codigo || '',
        fontes: (original.fontes || []).slice(),
        autor: autor ? { id: autor.id, nome: autor.nome } : null,
        atualizadoPor: autor ? { id: autor.id, nome: autor.nome } : null,
        criadoEm: agora,
        atualizadoEm: agora,
        versoes: []
    };
    db.dashboards.push(copia);
    salvar();
    return copia;
}

function removerDashboard(id) {
    const db = carregar();
    const antes = db.dashboards.length;
    db.dashboards = db.dashboards.filter(d => d.id !== id);
    if (db.dashboards.length === antes) {
        throw Object.assign(new Error('Dashboard não encontrado.'), { status: 404 });
    }
    salvar();
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

/**
 * Garante que exista pelo menos um administrador.
 * A senha inicial é gerada e impressa uma única vez — nada de "admin/admin"
 * embutido no código, que é o tipo de credencial que sobrevive até produção.
 */
function garantirAdmin() {
    const db = carregar();
    if (db.usuarios.length) return null;

    const grupoAdmin = criarGrupo({
        nome: 'Administradores', admin: true,
        paginas: PAGINAS_CONTROLAVEIS.slice(), dashboards: 'todos', aplicacoes: 'todos'
    });
    const senha = crypto.randomBytes(6).toString('base64url');  // 8 caracteres
    criarUsuario({ login: 'admin', nome: 'Administrador', senha, grupoId: grupoAdmin.id });
    return senha;
}

/**
 * Só para o teste automatizado: descarta o que está em memória para o próximo
 * carregar() ler de novo do zero. Espera a fila de escrita esvaziar antes —
 * senão uma gravação do teste anterior, ainda em voo, erra ao gravar num
 * arquivo temporário que o próximo teste já apagou. Nunca chamar a partir do servidor.
 */
async function _resetParaTestes() {
    await filaEscrita.catch(() => {});
    await filaSessoes.catch(() => {});
    cache = null;
    cacheSessoes = null;
    cacheAcessos = null;
    filaEscrita = Promise.resolve();
    filaSessoes = Promise.resolve();
}

module.exports = {
    carregar, salvar,
    listarUsuarios, acharUsuario, acharUsuarioPorLogin, criarUsuario, atualizarUsuario, removerUsuario,
    autenticar, usuarioDaSessao, encerrarSessao, limparSessoesVencidas, encerrarTodasSessoes,
    listarDashboards, acharDashboard, salvarDashboard, removerDashboard,
    listarVersoes, restaurarVersao, duplicarDashboard,
    listarGrupos, acharGrupo, criarGrupo, atualizarGrupo, removerGrupo, contarUsuariosNoGrupo,
    permissoesDoUsuario,
    garantirAdmin, PAGINAS_CONTROLAVEIS, DURACAO_SESSAO_MS,
    _resetParaTestes
};
