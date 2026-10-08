/**
 * Camada de acesso ao banco MySQL/MariaDB
 * ---------------------------------------------------------------------------
 * Tudo o que o sistema guarda mora aqui: grupos, usuários, sessões, painéis
 * (com histórico de versões) e as próprias planilhas. Um banco só, acessado
 * igual do computador local e da Hostinger — local e hospedado sempre veem os
 * mesmos dados, e nada some entre deploys.
 *
 * Compatível com MySQL 8 e MariaDB 10.x (a Hostinger usa MariaDB): por isso as
 * listas ficam em colunas TEXT com JSON escrito à mão, e não no tipo JSON, que
 * no MariaDB é só um apelido de LONGTEXT e volta como string.
 *
 * Datas são gravadas e lidas em UTC (timezone 'Z' no pool), e a comparação de
 * validade das sessões usa a hora do Node, nunca NOW() do servidor de banco —
 * assim o fuso configurado no MySQL da hospedagem não interfere.
 */

const crypto = require('crypto');

// Carregado só em iniciar(): se o `npm install` não rodou na hospedagem, o
// servidor ainda sobe e diz o que falta, em vez de cair já no require.
let mysql = null;
let pool = null;

// Planilhas são gravadas em pedaços: o max_allowed_packet de hospedagem
// compartilhada costuma ser baixo, e uma planilha de obra passa de 10 MB.
const TAMANHO_PARTE = 2 * 1024 * 1024;

const ESQUEMA = [
    `CREATE TABLE IF NOT EXISTS grupos (
        id            VARCHAR(32)  NOT NULL PRIMARY KEY,
        nome          VARCHAR(60)  NOT NULL,
        admin         TINYINT(1)   NOT NULL DEFAULT 0,
        paginas       TEXT         NOT NULL,
        dashboards    MEDIUMTEXT   NOT NULL,
        criado_em     DATETIME(3)  NOT NULL,
        atualizado_em DATETIME(3)  NOT NULL,
        UNIQUE KEY uk_grupos_nome (nome)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS usuarios (
        id            VARCHAR(32)  NOT NULL PRIMARY KEY,
        login         VARCHAR(32)  NOT NULL,
        nome          VARCHAR(80)  NOT NULL,
        email         VARCHAR(190) NULL,
        grupo_id      VARCHAR(32)  NOT NULL,
        senha         VARCHAR(200) NOT NULL,
        criado_em     DATETIME(3)  NOT NULL,
        ultimo_acesso DATETIME(3)  NULL,
        UNIQUE KEY uk_usuarios_login (login),
        KEY ix_usuarios_grupo (grupo_id),
        CONSTRAINT fk_usuarios_grupo FOREIGN KEY (grupo_id) REFERENCES grupos(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS sessoes (
        token         CHAR(64)     NOT NULL PRIMARY KEY,
        usuario_id    VARCHAR(32)  NOT NULL,
        criada_em     DATETIME(3)  NOT NULL,
        expira_em     DATETIME(3)  NOT NULL,
        KEY ix_sessoes_expira (expira_em),
        CONSTRAINT fk_sessoes_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS dashboards (
        id                  VARCHAR(80)  NOT NULL PRIMARY KEY,
        titulo              VARCHAR(200) NOT NULL,
        descricao           VARCHAR(240) NOT NULL DEFAULT '',
        codigo              LONGTEXT     NOT NULL,
        fontes              TEXT         NOT NULL,
        autor_id            VARCHAR(32)  NULL,
        autor_nome          VARCHAR(80)  NULL,
        atualizado_por_id   VARCHAR(32)  NULL,
        atualizado_por_nome VARCHAR(80)  NULL,
        criado_em           DATETIME(3)  NOT NULL,
        atualizado_em       DATETIME(3)  NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS dashboard_versoes (
        id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        dashboard_id        VARCHAR(80)  NOT NULL,
        codigo              LONGTEXT     NOT NULL,
        fontes              TEXT         NOT NULL,
        descricao           VARCHAR(240) NOT NULL DEFAULT '',
        atualizado_em       DATETIME(3)  NULL,
        atualizado_por_id   VARCHAR(32)  NULL,
        atualizado_por_nome VARCHAR(80)  NULL,
        KEY ix_versoes_dashboard (dashboard_id),
        CONSTRAINT fk_versoes_dashboard FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS planilhas (
        nome                VARCHAR(191) NOT NULL PRIMARY KEY,
        tamanho             BIGINT UNSIGNED NOT NULL,
        partes              INT UNSIGNED NOT NULL,
        sha256              CHAR(64)     NOT NULL,
        enviado_por_id      VARCHAR(32)  NULL,
        enviado_por_nome    VARCHAR(80)  NULL,
        atualizado_em       DATETIME(3)  NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS planilha_partes (
        nome   VARCHAR(191) NOT NULL,
        parte  INT UNSIGNED NOT NULL,
        dados  MEDIUMBLOB   NOT NULL,
        PRIMARY KEY (nome, parte),
        CONSTRAINT fk_partes_planilha FOREIGN KEY (nome) REFERENCES planilhas(nome) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Versões anteriores de cada planilha: reenviar não apaga a de antes.
    `CREATE TABLE IF NOT EXISTS planilha_versoes (
        id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        nome                VARCHAR(191) NOT NULL,
        tamanho             BIGINT UNSIGNED NOT NULL,
        partes              INT UNSIGNED NOT NULL,
        sha256              CHAR(64)     NOT NULL,
        enviado_por_id      VARCHAR(32)  NULL,
        enviado_por_nome    VARCHAR(80)  NULL,
        atualizado_em       DATETIME(3)  NOT NULL,
        substituida_em      DATETIME(3)  NOT NULL,
        KEY ix_pversoes_nome (nome)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS planilha_versao_partes (
        versao_id  BIGINT UNSIGNED NOT NULL,
        parte      INT UNSIGNED NOT NULL,
        dados      MEDIUMBLOB   NOT NULL,
        PRIMARY KEY (versao_id, parte),
        CONSTRAINT fk_vpartes_versao FOREIGN KEY (versao_id) REFERENCES planilha_versoes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

/**
 * Colunas que entraram depois da primeira versão das tabelas. CREATE TABLE IF
 * NOT EXISTS não mexe numa tabela que já existe, então cada uma é conferida no
 * information_schema e criada se faltar (o "ADD COLUMN IF NOT EXISTS" é só do
 * MariaDB; isto funciona nos dois).
 */
const COLUNAS_NOVAS = [
    // Senha definida por um admin (usuário novo ou senha redefinida) precisa ser
    // trocada pelo próprio usuário no primeiro acesso.
    { tabela: 'usuarios', coluna: 'trocar_senha', definicao: 'TINYINT(1) NOT NULL DEFAULT 0' }
];

async function migrarColunas(p) {
    for (const { tabela, coluna, definicao } of COLUNAS_NOVAS) {
        const [linhas] = await p.query(
            `SELECT 1 FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [tabela, coluna]);
        if (!linhas.length) await p.query('ALTER TABLE ' + tabela + ' ADD COLUMN ' + coluna + ' ' + definicao);
    }
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

function configDoAmbiente() {
    return {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || '',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || ''
    };
}

function configurado() {
    const c = configDoAmbiente();
    return Boolean(c.user && c.database);
}

/**
 * Abre o pool e cria as tabelas que faltarem. Chamar uma vez, antes de tudo.
 * Se falhar, o pool é descartado — chamar de novo tenta do zero.
 */
async function iniciar(config) {
    if (pool) return;
    if (!mysql) {
        try {
            mysql = require('mysql2/promise');
        } catch {
            throw Object.assign(new Error('Dependência mysql2 não instalada. Rode "npm install" no servidor.'),
                { code: 'SEM_MYSQL2' });
        }
    }
    const c = Object.assign(configDoAmbiente(), config || {});
    const novo = mysql.createPool({
        host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
        charset: 'utf8mb4',
        timezone: 'Z',
        connectionLimit: Number(process.env.DB_CONEXOES) || 5,
        connectTimeout: 15000,
        enableKeepAlive: true,
        waitForConnections: true
    });
    try {
        for (const sql of ESQUEMA) await novo.query(sql);
        await migrarColunas(novo);
    } catch (err) {
        await novo.end().catch(() => {});
        throw err;
    }
    pool = novo;
}

/** Traduz o erro de conexão para algo que diga o que fazer, sem expor a senha. */
function explicarErroConexao(err) {
    const c = configDoAmbiente();
    const onde = c.host + ':' + c.port + '/' + c.database;   // sem usuário: a mensagem aparece na página de status
    switch (err && err.code) {
        case 'SEM_MYSQL2': return err.message;
        case 'ER_ACCESS_DENIED_ERROR': return 'O MySQL recusou usuário/senha (' + onde + '). Confira DB_USER e DB_PASSWORD.';
        case 'ER_BAD_DB_ERROR': return 'O banco "' + c.database + '" não existe. Confira DB_NAME.';
        case 'ENOTFOUND': return 'Host do banco não encontrado: "' + c.host + '". Confira DB_HOST.';
        case 'ECONNREFUSED': return 'Conexão recusada em ' + c.host + ':' + c.port + '. Confira DB_HOST e DB_PORT.';
        case 'ETIMEDOUT': return 'Tempo esgotado ao conectar em ' + c.host + ':' + c.port + '. Confira DB_HOST (na Hostinger, use localhost).';
        default: return 'Falha ao conectar no banco (' + onde + '): ' + ((err && (err.code || err.message)) || 'erro desconhecido');
    }
}

function pronto() {
    return Boolean(pool);
}

async function encerrar() {
    if (!pool) return;
    const p = pool;
    pool = null;
    await p.end();
}

function conexao() {
    if (!pool) throw new Error('Banco não iniciado: chame db.iniciar() antes.');
    return pool;
}

async function consultar(sql, params) {
    const [linhas] = await conexao().query(sql, params);
    return linhas;
}

async function transacao(fn) {
    const c = await conexao().getConnection();
    try {
        await c.beginTransaction();
        const resultado = await fn(c);
        await c.commit();
        return resultado;
    } catch (err) {
        await c.rollback().catch(() => {});
        throw err;
    } finally {
        c.release();
    }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function erro(mensagem, status) {
    return Object.assign(new Error(mensagem), { status });
}

function novoId() {
    return crypto.randomBytes(9).toString('hex');
}

function iso(data) {
    return data ? new Date(data).toISOString() : null;
}

function lerJSON(texto, padrao) {
    try { return JSON.parse(texto); } catch { return padrao; }
}

function pessoa(id, nome) {
    return id || nome ? { id: id || null, nome: nome || null } : null;
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

// ---------------------------------------------------------------------------
// Grupos — controlam, para quem não é admin, quais páginas e painéis
// aparecem. Admin sempre vê tudo, grupo nenhum restringe.
// ---------------------------------------------------------------------------

// Páginas que um grupo pode liberar ou não para um visualizador. Editor e
// Usuários continuam exclusivos de admin, grupo nenhum muda isso.
const PAGINAS_CONTROLAVEIS = ['galeria', 'planilhas'];

function grupoDaLinha(l) {
    if (!l) return null;
    return {
        id: l.id,
        nome: l.nome,
        admin: Boolean(l.admin),
        paginas: lerJSON(l.paginas, []),
        dashboards: lerJSON(l.dashboards, []),
        criadoEm: iso(l.criado_em),
        atualizadoEm: iso(l.atualizado_em)
    };
}

/** 'todos' passa direto; qualquer outra coisa vira lista de ids únicos (nunca null/undefined soltos). */
function normalizarListaOuTodos(valor) {
    if (valor === 'todos') return 'todos';
    if (Array.isArray(valor)) return [...new Set(valor.map(String).filter(Boolean))];
    return [];
}

function filtrarPaginas(paginas) {
    return Array.isArray(paginas) ? [...new Set(paginas.filter(p => PAGINAS_CONTROLAVEIS.includes(p)))] : [];
}

async function listarGrupos() {
    const linhas = await consultar(
        `SELECT g.*, (SELECT COUNT(*) FROM usuarios u WHERE u.grupo_id = g.id) AS total_usuarios
           FROM grupos g ORDER BY g.nome`);
    return linhas.map(l => Object.assign(grupoDaLinha(l), { usuarios: Number(l.total_usuarios) }));
}

async function acharGrupo(id, c) {
    if (!id) return null;
    const [linhas] = await (c || conexao()).query('SELECT * FROM grupos WHERE id = ?', [id]);
    return grupoDaLinha(linhas[0]);
}

async function contarUsuariosNoGrupo(id) {
    const [{ total }] = await consultar('SELECT COUNT(*) AS total FROM usuarios WHERE grupo_id = ?', [id]);
    return Number(total);
}

/** Quantos usuários resolvem para admin agora, opcionalmente sem contar um usuário/grupo específico. */
async function contarAdmins(c, { semUsuarioId, semGrupoId } = {}) {
    const [[{ total }]] = await c.query(
        `SELECT COUNT(*) AS total FROM usuarios u JOIN grupos g ON g.id = u.grupo_id
          WHERE g.admin = 1 AND u.id <> ? AND g.id <> ?`,
        [semUsuarioId || '', semGrupoId || '']);
    return Number(total);
}

async function nomeDeGrupoEmUso(c, nome, semId) {
    const [linhas] = await c.query('SELECT id FROM grupos WHERE LOWER(nome) = LOWER(?) AND id <> ?', [nome, semId || '']);
    return linhas.length > 0;
}

async function criarGrupo({ nome, admin, paginas, dashboards }) {
    const nomeLimpo = String(nome || '').trim().slice(0, 60);
    if (!nomeLimpo) throw erro('Dê um nome para o grupo.', 400);

    return transacao(async c => {
        if (await nomeDeGrupoEmUso(c, nomeLimpo)) throw erro('Já existe um grupo com esse nome.', 409);
        const agora = new Date();
        const grupo = {
            id: novoId(),
            nome: nomeLimpo,
            admin: Boolean(admin),
            paginas: filtrarPaginas(paginas),
            dashboards: normalizarListaOuTodos(dashboards),
            criadoEm: agora.toISOString(),
            atualizadoEm: agora.toISOString()
        };
        await c.query(
            'INSERT INTO grupos (id, nome, admin, paginas, dashboards, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [grupo.id, grupo.nome, grupo.admin ? 1 : 0, JSON.stringify(grupo.paginas),
             JSON.stringify(grupo.dashboards), agora, agora]);
        return grupo;
    });
}

async function atualizarGrupo(id, campos) {
    return transacao(async c => {
        const grupo = await acharGrupo(id, c);
        if (!grupo) throw erro('Grupo não encontrado.', 404);

        if (campos.nome !== undefined) {
            const nomeLimpo = String(campos.nome).trim().slice(0, 60);
            if (!nomeLimpo) throw erro('Dê um nome para o grupo.', 400);
            if (await nomeDeGrupoEmUso(c, nomeLimpo, id)) throw erro('Já existe um grupo com esse nome.', 409);
            grupo.nome = nomeLimpo;
        }
        if (campos.admin !== undefined) {
            const novoAdmin = Boolean(campos.admin);
            // Tirar o "admin" deste grupo só é um problema se alguém aqui dentro
            // realmente perderia o acesso — um grupo admin vazio pode virar comum à vontade.
            if (grupo.admin && !novoAdmin) {
                const [[{ membros }]] = await c.query('SELECT COUNT(*) AS membros FROM usuarios WHERE grupo_id = ?', [id]);
                if (Number(membros) > 0 && await contarAdmins(c, { semGrupoId: id }) === 0) {
                    throw erro('Isso deixaria o sistema sem nenhum administrador. Mova os usuários deste grupo para outro grupo admin antes.', 400);
                }
            }
            grupo.admin = novoAdmin;
        }
        if (campos.paginas !== undefined) grupo.paginas = filtrarPaginas(campos.paginas);
        if (campos.dashboards !== undefined) grupo.dashboards = normalizarListaOuTodos(campos.dashboards);

        const agora = new Date();
        grupo.atualizadoEm = agora.toISOString();
        await c.query(
            'UPDATE grupos SET nome = ?, admin = ?, paginas = ?, dashboards = ?, atualizado_em = ? WHERE id = ?',
            [grupo.nome, grupo.admin ? 1 : 0, JSON.stringify(grupo.paginas), JSON.stringify(grupo.dashboards), agora, id]);
        return grupo;
    });
}

async function removerGrupo(id) {
    return transacao(async c => {
        if (!await acharGrupo(id, c)) throw erro('Grupo não encontrado.', 404);
        // Todo usuário precisa estar em algum grupo — sem para onde mandar os membros,
        // apagar o grupo os deixaria sem papel nenhum. Move primeiro, depois remove.
        const [[{ membros }]] = await c.query('SELECT COUNT(*) AS membros FROM usuarios WHERE grupo_id = ?', [id]);
        const n = Number(membros);
        if (n > 0) {
            throw erro('Mova ' + (n === 1 ? 'o usuário deste grupo' : 'os ' + n + ' usuários deste grupo') + ' para outro grupo antes de removê-lo.', 400);
        }
        await c.query('DELETE FROM grupos WHERE id = ?', [id]);
        return true;
    });
}

// ---------------------------------------------------------------------------
// Usuários
// ---------------------------------------------------------------------------

function emailValido(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

/**
 * Resolve o que um usuário pode ver. Admin não passa por grupo (vê tudo);
 * visualizador herda exatamente o que o grupo libera.
 */
function permissoesDoGrupo(admin, paginas, dashboards) {
    if (admin) return { paginas: 'todos', dashboards: 'todos' };
    return { paginas: lerJSON(paginas, []), dashboards: lerJSON(dashboards, []) };
}

const SELECT_USUARIO =
    `SELECT u.*, g.nome AS grupo_nome, g.admin AS grupo_admin,
            g.paginas AS grupo_paginas, g.dashboards AS grupo_dashboards
       FROM usuarios u LEFT JOIN grupos g ON g.id = u.grupo_id`;

/**
 * Nunca devolve o hash da senha. O papel não é um campo do usuário: vem do
 * grupo (grupo.admin), assim como as permissões.
 */
function usuarioDaLinha(l) {
    if (!l) return null;
    const admin = Boolean(l.grupo_admin);
    return {
        id: l.id,
        login: l.login,
        nome: l.nome,
        email: l.email,
        grupoId: l.grupo_id,
        grupoNome: l.grupo_nome || null,
        papel: admin ? 'admin' : 'visualizador',
        permissoes: permissoesDoGrupo(admin, l.grupo_paginas, l.grupo_dashboards),
        criadoEm: iso(l.criado_em),
        ultimoAcesso: iso(l.ultimo_acesso),
        trocarSenha: Boolean(l.trocar_senha)
    };
}

/** Para quem já tem o usuário em mãos (vindo da sessão): as permissões já vêm resolvidas. */
function permissoesDoUsuario(usuario) {
    if (!usuario) return { paginas: [], dashboards: [] };
    if (usuario.papel === 'admin') return { paginas: 'todos', dashboards: 'todos' };
    return usuario.permissoes || { paginas: [], dashboards: [] };
}

async function listarUsuarios() {
    const linhas = await consultar(SELECT_USUARIO + ' ORDER BY u.nome');
    return linhas.map(usuarioDaLinha);
}

async function acharUsuario(id, c) {
    const [linhas] = await (c || conexao()).query(SELECT_USUARIO + ' WHERE u.id = ?', [id]);
    return usuarioDaLinha(linhas[0]);
}

async function acharUsuarioPorLogin(login) {
    const linhas = await consultar(SELECT_USUARIO + ' WHERE u.login = ?', [String(login || '').trim().toLowerCase()]);
    return usuarioDaLinha(linhas[0]);
}

async function criarUsuario({ login, nome, senha, email, grupoId }) {
    const limpo = String(login || '').trim().toLowerCase();

    if (!/^[a-z0-9._-]{3,32}$/.test(limpo)) {
        throw erro('Login deve ter 3 a 32 caracteres (letras, números, ponto, hífen ou _).', 400);
    }
    if (String(senha || '').length < 6) throw erro('A senha precisa de pelo menos 6 caracteres.', 400);
    const emailLimpo = email ? String(email).trim().toLowerCase() : null;
    if (emailLimpo && !emailValido(emailLimpo)) throw erro('E-mail inválido.', 400);

    return transacao(async c => {
        const [existentes] = await c.query('SELECT id FROM usuarios WHERE login = ?', [limpo]);
        if (existentes.length) throw erro('Já existe um usuário com esse login.', 409);
        // O grupo decide se é admin — todo usuário precisa estar em um.
        if (!await acharGrupo(grupoId, c)) throw erro('Selecione um grupo para o usuário.', 400);

        const id = novoId();
        await c.query(
            // trocar_senha = 1: quem escolheu esta senha foi o admin, não o usuário.
            'INSERT INTO usuarios (id, login, nome, email, grupo_id, senha, criado_em, trocar_senha) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
            [id, limpo, String(nome || limpo).trim().slice(0, 80) || limpo, emailLimpo, grupoId,
             gerarHashSenha(senha), new Date()]);
        return acharUsuario(id, c);
    });
}

async function atualizarUsuario(id, campos) {
    return transacao(async c => {
        const usuario = await acharUsuario(id, c);
        if (!usuario) throw erro('Usuário não encontrado.', 404);
        const mudancas = {};

        if (campos.nome !== undefined) {
            const nome = String(campos.nome).trim().slice(0, 80);
            if (!nome) throw erro('Informe o nome.', 400);
            mudancas.nome = nome;
        }
        if (campos.email !== undefined) {
            const emailLimpo = campos.email ? String(campos.email).trim().toLowerCase() : null;
            if (emailLimpo && !emailValido(emailLimpo)) throw erro('E-mail inválido.', 400);
            mudancas.email = emailLimpo;
        }
        if (campos.grupoId !== undefined && campos.grupoId !== usuario.grupoId) {
            const novoGrupo = await acharGrupo(campos.grupoId, c);
            if (!novoGrupo) throw erro('Grupo não encontrado.', 400);
            // Nunca deixar o sistema sem nenhum admin: se tirar este usuário de um
            // grupo admin, precisa sobrar pelo menos um outro em grupo admin.
            if (usuario.papel === 'admin' && !novoGrupo.admin && await contarAdmins(c, { semUsuarioId: id }) === 0) {
                throw erro('Este é o único administrador; mova outro usuário para um grupo admin antes.', 400);
            }
            mudancas.grupo_id = campos.grupoId;
        }
        if (campos.senha) {
            if (String(campos.senha).length < 6) throw erro('A senha precisa de pelo menos 6 caracteres.', 400);
            mudancas.senha = gerarHashSenha(campos.senha);
            mudancas.trocar_senha = 1;   // senha redefinida pelo admin: o usuário escolhe a dele no próximo acesso
            // Trocar a senha derruba as sessões abertas daquele usuário.
            await c.query('DELETE FROM sessoes WHERE usuario_id = ?', [id]);
        }

        if (Object.keys(mudancas).length) await c.query('UPDATE usuarios SET ? WHERE id = ?', [mudancas, id]);
        return acharUsuario(id, c);
    });
}

const MINIMO_SENHA_PROPRIA = 8;

/**
 * O próprio usuário troca a senha ("Minha conta"). Exige a senha atual, para
 * uma sessão esquecida aberta não bastar para tomar a conta. As outras sessões
 * dele caem; a atual (de onde ele trocou) continua valendo.
 */
async function trocarPropriaSenha(id, senhaAtual, novaSenha, tokenAtual) {
    const nova = String(novaSenha || '');
    if (nova.length < MINIMO_SENHA_PROPRIA) {
        throw erro('A nova senha precisa de pelo menos ' + MINIMO_SENHA_PROPRIA + ' caracteres.', 400);
    }
    if (!/[A-Za-z]/.test(nova) || !/\d/.test(nova)) throw erro('Use letras e números na nova senha.', 400);

    return transacao(async c => {
        const [[registro]] = await c.query('SELECT senha FROM usuarios WHERE id = ?', [id]);
        if (!registro) throw erro('Usuário não encontrado.', 404);
        if (!conferirSenha(senhaAtual, registro.senha)) throw erro('A senha atual está incorreta.', 400);
        if (conferirSenha(nova, registro.senha)) throw erro('A nova senha precisa ser diferente da atual.', 400);

        await c.query('UPDATE usuarios SET senha = ?, trocar_senha = 0 WHERE id = ?', [gerarHashSenha(nova), id]);
        await c.query('DELETE FROM sessoes WHERE usuario_id = ? AND token <> ?', [id, tokenAtual || '']);
        return acharUsuario(id, c);
    });
}

/** O próprio usuário atualiza nome e e-mail. Grupo e papel continuam só com o admin. */
async function atualizarPropriaConta(id, { nome, email }) {
    return atualizarUsuario(id, { nome, email });
}

async function removerUsuario(id) {
    return transacao(async c => {
        const usuario = await acharUsuario(id, c);
        if (!usuario) throw erro('Usuário não encontrado.', 404);
        if (usuario.papel === 'admin' && await contarAdmins(c, { semUsuarioId: id }) === 0) {
            throw erro('Não é possível remover o único administrador.', 400);
        }
        await c.query('DELETE FROM usuarios WHERE id = ?', [id]);   // sessões caem em cascata
        return true;
    });
}

// ---------------------------------------------------------------------------
// Sessões
// ---------------------------------------------------------------------------

const DURACAO_SESSAO_MS = 12 * 60 * 60 * 1000;   // 12 h: um turno de trabalho

// Hash fixo para gastar o mesmo tempo quando o login não existe.
const HASH_FALSO = gerarHashSenha('senha-inexistente');

async function autenticar(login, senha) {
    const [linhas] = await conexao().query('SELECT id, senha FROM usuarios WHERE login = ?',
        [String(login || '').trim().toLowerCase()]);
    const registro = linhas[0];
    // Mesmo sem usuário, gastamos tempo derivando a senha: assim o tempo de
    // resposta não denuncia quais logins existem.
    const ok = conferirSenha(senha, registro ? registro.senha : HASH_FALSO);
    if (!ok || !registro) return null;

    const agora = new Date();
    const token = crypto.randomBytes(32).toString('hex');
    await consultar('INSERT INTO sessoes (token, usuario_id, criada_em, expira_em) VALUES (?, ?, ?, ?)',
        [token, registro.id, agora, new Date(agora.getTime() + DURACAO_SESSAO_MS)]);
    await consultar('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?', [agora, registro.id]);
    return { token, usuario: await acharUsuario(registro.id) };
}

async function usuarioDaSessao(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const linhas = await consultar(
        SELECT_USUARIO + ' JOIN sessoes s ON s.usuario_id = u.id WHERE s.token = ? AND s.expira_em > ?',
        [token, new Date()]);
    return usuarioDaLinha(linhas[0]);
}

async function encerrarSessao(token) {
    if (!token) return;
    await consultar('DELETE FROM sessoes WHERE token = ?', [token]);
}

async function limparSessoesVencidas() {
    await consultar('DELETE FROM sessoes WHERE expira_em <= ?', [new Date()]);
}

/** Invalida todas as sessões abertas. Usado quando um token pode ter vazado. */
async function encerrarTodasSessoes() {
    await consultar('DELETE FROM sessoes');
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

const MAX_VERSOES = 15; // histórico é uma rede de segurança, não um repositório git

function dashboardDaLinha(l) {
    if (!l) return null;
    return {
        id: l.id,
        titulo: l.titulo,
        descricao: l.descricao,
        codigo: l.codigo,
        fontes: lerJSON(l.fontes, []),
        autor: pessoa(l.autor_id, l.autor_nome),
        atualizadoPor: pessoa(l.atualizado_por_id, l.atualizado_por_nome),
        criadoEm: iso(l.criado_em),
        atualizadoEm: iso(l.atualizado_em)
    };
}

async function listarDashboards() {
    const linhas = await consultar(
        `SELECT id, titulo, descricao, fontes, autor_id, autor_nome, atualizado_por_id, atualizado_por_nome,
                criado_em, atualizado_em, CHAR_LENGTH(codigo) AS tamanho_codigo
           FROM dashboards ORDER BY atualizado_em DESC`);
    return linhas.map(l => {
        const d = dashboardDaLinha(Object.assign({}, l, { codigo: undefined }));
        delete d.codigo;
        d.tamanhoCodigo = Number(l.tamanho_codigo) || 0;
        return d;
    });
}

async function acharDashboard(id, c) {
    const [linhas] = await (c || conexao()).query('SELECT * FROM dashboards WHERE id = ?', [id]);
    return dashboardDaLinha(linhas[0]);
}

async function gerarSlug(c, titulo) {
    const base = String(titulo || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 60) || 'dashboard';

    const [linhas] = await c.query('SELECT id FROM dashboards WHERE id = ? OR id LIKE ?', [base, base + '-%']);
    const usados = new Set(linhas.map(l => l.id));
    let candidato = base, n = 2;
    while (usados.has(candidato)) candidato = base + '-' + (n++);
    return candidato;
}

/** Empurra o estado atual para o histórico e corta o que passar do limite. */
async function arquivarVersao(c, atual) {
    await c.query(
        `INSERT INTO dashboard_versoes (dashboard_id, codigo, fontes, descricao, atualizado_em, atualizado_por_id, atualizado_por_nome)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [atual.id, atual.codigo, JSON.stringify(atual.fontes || []), atual.descricao || '',
         atual.atualizadoEm ? new Date(atual.atualizadoEm) : null,
         atual.atualizadoPor ? atual.atualizadoPor.id : null, atual.atualizadoPor ? atual.atualizadoPor.nome : null]);
    const [antigas] = await c.query(
        'SELECT id FROM dashboard_versoes WHERE dashboard_id = ? ORDER BY id DESC LIMIT 1000 OFFSET ' + MAX_VERSOES,
        [atual.id]);
    if (antigas.length) await c.query('DELETE FROM dashboard_versoes WHERE id IN (?)', [antigas.map(v => v.id)]);
}

async function salvarDashboard({ id, titulo, descricao, codigo, fontes }, autor) {
    const nome = String(titulo || '').trim().slice(0, 200);
    if (!nome) throw erro('Informe um título para o dashboard.', 400);

    const codigoNovo = typeof codigo === 'string' ? codigo : '';
    const fontesLimpas = Array.isArray(fontes) ? fontes.filter(f => typeof f === 'string').slice(0, 40) : [];
    const descricaoLimpa = String(descricao || '').trim().slice(0, 240);
    const agora = new Date();

    return transacao(async c => {
        const existente = id ? await acharDashboard(id, c) : null;

        if (existente) {
            // Só entra uma versão nova no histórico se o código de fato mudou — salvar
            // sem editar nada não deveria empurrar histórico útil para fora da pilha.
            if (existente.codigo !== codigoNovo) await arquivarVersao(c, existente);
            await c.query(
                `UPDATE dashboards SET titulo = ?, descricao = ?, codigo = ?, fontes = ?,
                        atualizado_por_id = ?, atualizado_por_nome = ?, atualizado_em = ? WHERE id = ?`,
                [nome, descricaoLimpa, codigoNovo, JSON.stringify(fontesLimpas),
                 autor ? autor.id : null, autor ? autor.nome : null, agora, existente.id]);
            return acharDashboard(existente.id, c);
        }

        const novoIdDash = await gerarSlug(c, nome);
        await c.query(
            `INSERT INTO dashboards (id, titulo, descricao, codigo, fontes, autor_id, autor_nome,
                                     atualizado_por_id, atualizado_por_nome, criado_em, atualizado_em)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [novoIdDash, nome, descricaoLimpa, codigoNovo, JSON.stringify(fontesLimpas),
             autor ? autor.id : null, autor ? autor.nome : null,
             autor ? autor.id : null, autor ? autor.nome : null, agora, agora]);
        return acharDashboard(novoIdDash, c);
    });
}

/** Histórico de um dashboard, mais recente primeiro; o índice é a posição nesta lista. */
async function versoesDe(c, id) {
    const [linhas] = await c.query('SELECT * FROM dashboard_versoes WHERE dashboard_id = ? ORDER BY id DESC', [id]);
    return linhas;
}

/** Lista o histórico de um dashboard, sem o código (só o cabeçalho de cada versão). */
async function listarVersoes(id) {
    if (!await acharDashboard(id)) throw erro('Dashboard não encontrado.', 404);
    const linhas = await versoesDe(conexao(), id);
    return linhas.map((v, indice) => ({
        indice,
        descricao: v.descricao,
        fontes: lerJSON(v.fontes, []),
        atualizadoEm: iso(v.atualizado_em),
        atualizadoPor: pessoa(v.atualizado_por_id, v.atualizado_por_nome),
        tamanhoCodigo: (v.codigo || '').length
    }));
}

/**
 * Restaura uma versão antiga como a atual. O que estava valendo até agora
 * também vira uma entrada no histórico — restaurar nunca é uma via sem volta.
 */
async function restaurarVersao(id, indice, autor) {
    return transacao(async c => {
        const dashboard = await acharDashboard(id, c);
        if (!dashboard) throw erro('Dashboard não encontrado.', 404);
        const alvo = (await versoesDe(c, id))[indice];
        if (!alvo) throw erro('Versão não encontrada.', 404);

        await c.query('DELETE FROM dashboard_versoes WHERE id = ?', [alvo.id]);
        await arquivarVersao(c, dashboard);
        await c.query(
            `UPDATE dashboards SET codigo = ?, fontes = ?, atualizado_por_id = ?, atualizado_por_nome = ?, atualizado_em = ?
              WHERE id = ?`,
            [alvo.codigo, alvo.fontes, autor ? autor.id : null, autor ? autor.nome : null, new Date(), id]);
        return acharDashboard(id, c);
    });
}

/** Cria uma cópia independente — a nova instância começa sem histórico próprio. */
async function duplicarDashboard(id, autor) {
    const original = await acharDashboard(id);
    if (!original) throw erro('Dashboard não encontrado.', 404);
    return salvarDashboard({
        titulo: original.titulo + ' (cópia)',
        descricao: original.descricao,
        codigo: original.codigo,
        fontes: original.fontes
    }, autor);
}

async function removerDashboard(id) {
    const [resultado] = await conexao().query('DELETE FROM dashboards WHERE id = ?', [id]);
    if (!resultado.affectedRows) throw erro('Dashboard não encontrado.', 404);
}

/**
 * Tira o painel removido das listas dos grupos — sem isso, um painel novo
 * criado depois com o mesmo id herdaria o acesso do antigo.
 */
async function removerDashboardDosGrupos(id) {
    const grupos = await consultar('SELECT id, dashboards FROM grupos');
    for (const g of grupos) {
        const lista = lerJSON(g.dashboards, []);
        if (Array.isArray(lista) && lista.includes(id)) {
            await consultar('UPDATE grupos SET dashboards = ? WHERE id = ?',
                [JSON.stringify(lista.filter(x => x !== id)), g.id]);
        }
    }
}

// ---------------------------------------------------------------------------
// Planilhas — o arquivo inteiro fica no banco, em pedaços de 2 MB.
// ---------------------------------------------------------------------------

function planilhaDaLinha(l) {
    // O apelido (P21, 01...) é o que o editor mostra e o runtime resolve.
    const apelido = (l.nome.match(/^(p?\d+)/i) || [])[1];
    return {
        nome: l.nome,
        apelido: apelido ? apelido.toUpperCase() : null,
        tamanho: Number(l.tamanho),
        atualizadoEm: iso(l.atualizado_em),
        enviadoPor: pessoa(l.enviado_por_id, l.enviado_por_nome)
    };
}

async function listarPlanilhas() {
    const linhas = await consultar(
        'SELECT nome, tamanho, atualizado_em, enviado_por_id, enviado_por_nome FROM planilhas');
    return linhas.map(planilhaDaLinha)
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
}

/** Metadados da planilha (sem o conteúdo); null se não existir. */
async function acharPlanilha(nome) {
    const linhas = await consultar(
        'SELECT nome, tamanho, sha256, atualizado_em, enviado_por_id, enviado_por_nome FROM planilhas WHERE nome = ?', [nome]);
    if (!linhas[0]) return null;
    return Object.assign(planilhaDaLinha(linhas[0]), { sha256: linhas[0].sha256 });
}

/** Conteúdo completo da planilha; null se não existir. */
async function lerPlanilha(nome) {
    const meta = await acharPlanilha(nome);
    if (!meta) return null;
    const partes = await consultar('SELECT dados FROM planilha_partes WHERE nome = ? ORDER BY parte', [nome]);
    const dados = Buffer.concat(partes.map(p => p.dados));
    if (dados.length !== meta.tamanho) throw erro('Planilha "' + nome + '" está incompleta no banco; envie de novo.', 500);
    return { meta, dados };
}

const MAX_VERSOES_PLANILHA = 5;   // o suficiente para desfazer um envio errado sem inchar o banco

/**
 * Copia a planilha atual para o histórico antes de ela ser substituída. A cópia
 * dos bytes acontece dentro do MySQL (INSERT ... SELECT): nada trafega pela rede.
 */
async function arquivarPlanilhaAtual(c, nome, agora) {
    const [[atual]] = await c.query('SELECT * FROM planilhas WHERE nome = ?', [nome]);
    if (!atual) return;
    const [r] = await c.query(
        `INSERT INTO planilha_versoes (nome, tamanho, partes, sha256, enviado_por_id, enviado_por_nome, atualizado_em, substituida_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [nome, atual.tamanho, atual.partes, atual.sha256, atual.enviado_por_id, atual.enviado_por_nome, atual.atualizado_em, agora]);
    await c.query(
        'INSERT INTO planilha_versao_partes (versao_id, parte, dados) SELECT ?, parte, dados FROM planilha_partes WHERE nome = ?',
        [r.insertId, nome]);
    const [antigas] = await c.query(
        'SELECT id FROM planilha_versoes WHERE nome = ? ORDER BY id DESC LIMIT 1000 OFFSET ' + MAX_VERSOES_PLANILHA, [nome]);
    if (antigas.length) await c.query('DELETE FROM planilha_versoes WHERE id IN (?)', [antigas.map(v => v.id)]);
}

/**
 * Grava a planilha. Se já existia uma com esse nome e o conteúdo mudou, a
 * anterior vai para o histórico (últimas 5). `opcoes.removerVersaoId` é usado
 * ao restaurar: a versão que voltou a ser a atual sai do histórico.
 */
async function salvarPlanilha(nome, dados, autor, opcoes) {
    const sha = crypto.createHash('sha256').update(dados).digest('hex');
    const partes = Math.max(1, Math.ceil(dados.length / TAMANHO_PARTE));
    const agora = new Date();
    await transacao(async c => {
        const [[atual]] = await c.query('SELECT sha256 FROM planilhas WHERE nome = ?', [nome]);
        // Reenviar o mesmo arquivo não cria uma versão repetida no histórico.
        if (atual && atual.sha256 !== sha) await arquivarPlanilhaAtual(c, nome, agora);
        if (opcoes && opcoes.removerVersaoId) {
            await c.query('DELETE FROM planilha_versoes WHERE id = ? AND nome = ?', [opcoes.removerVersaoId, nome]);
        }
        await c.query('DELETE FROM planilhas WHERE nome = ?', [nome]);   // partes antigas saem em cascata
        await c.query(
            `INSERT INTO planilhas (nome, tamanho, partes, sha256, enviado_por_id, enviado_por_nome, atualizado_em)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [nome, dados.length, partes, sha, autor ? autor.id : null, autor ? autor.nome : null, agora]);
        for (let i = 0; i < partes; i++) {
            // execute (protocolo binário) manda os bytes crus, sem dobrar o tamanho em hex.
            await c.execute('INSERT INTO planilha_partes (nome, parte, dados) VALUES (?, ?, ?)',
                [nome, i, dados.subarray(i * TAMANHO_PARTE, (i + 1) * TAMANHO_PARTE)]);
        }
    });
    return acharPlanilha(nome);
}

/** Apaga a planilha e o histórico dela. */
async function removerPlanilha(nome) {
    return transacao(async c => {
        await c.query('DELETE FROM planilha_versoes WHERE nome = ?', [nome]);
        const [resultado] = await c.query('DELETE FROM planilhas WHERE nome = ?', [nome]);
        return resultado.affectedRows > 0;
    });
}

/** Versões anteriores de uma planilha, da mais recente para a mais antiga. */
async function listarVersoesPlanilha(nome) {
    const linhas = await consultar(
        `SELECT id, tamanho, enviado_por_id, enviado_por_nome, atualizado_em, substituida_em
           FROM planilha_versoes WHERE nome = ? ORDER BY id DESC`, [nome]);
    return linhas.map(l => ({
        id: Number(l.id),
        tamanho: Number(l.tamanho),
        enviadoPor: pessoa(l.enviado_por_id, l.enviado_por_nome),
        atualizadoEm: iso(l.atualizado_em),
        substituidaEm: iso(l.substituida_em)
    }));
}

/** Conteúdo de uma versão anterior; null se não existir. */
async function lerVersaoPlanilha(nome, versaoId) {
    const [meta] = await consultar('SELECT * FROM planilha_versoes WHERE id = ? AND nome = ?', [versaoId, nome]);
    if (!meta) return null;
    const partes = await consultar('SELECT dados FROM planilha_versao_partes WHERE versao_id = ? ORDER BY parte', [versaoId]);
    const dados = Buffer.concat(partes.map(p => p.dados));
    if (dados.length !== Number(meta.tamanho)) throw erro('Esta versão está incompleta no banco.', 500);
    return { meta: { id: Number(meta.id), sha256: meta.sha256, atualizadoEm: iso(meta.atualizado_em) }, dados };
}

/** Volta uma versão anterior a ser a atual; a que estava valendo vai para o histórico. */
async function restaurarVersaoPlanilha(nome, versaoId, autor) {
    const versao = await lerVersaoPlanilha(nome, versaoId);
    if (!versao) throw erro('Versão não encontrada.', 404);
    return salvarPlanilha(nome, versao.dados, autor, { removerVersaoId: versaoId });
}
// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

/**
 * Garante que exista pelo menos um administrador.
 * A senha inicial é gerada e impressa uma única vez — nada de "admin/admin"
 * embutido no código, que é o tipo de credencial que sobrevive até produção.
 */
async function garantirAdmin() {
    const [[{ total }]] = await conexao().query('SELECT COUNT(*) AS total FROM usuarios');
    if (Number(total)) return null;

    let grupoAdmin = (await listarGrupos()).find(g => g.admin);
    if (!grupoAdmin) {
        grupoAdmin = await criarGrupo({
            nome: 'Administradores', admin: true,
            paginas: PAGINAS_CONTROLAVEIS.slice(), dashboards: 'todos'
        });
    }
    const senha = crypto.randomBytes(6).toString('base64url');  // 8 caracteres
    await criarUsuario({ login: 'admin', nome: 'Administrador', senha, grupoId: grupoAdmin.id });
    return senha;
}

/** Contagens para o resumo que o servidor imprime ao subir. */
async function resumo() {
    const [[l]] = await conexao().query(
        `SELECT (SELECT COUNT(*) FROM usuarios) AS usuarios, (SELECT COUNT(*) FROM grupos) AS grupos,
                (SELECT COUNT(*) FROM dashboards) AS dashboards, (SELECT COUNT(*) FROM planilhas) AS planilhas`);
    return { usuarios: Number(l.usuarios), grupos: Number(l.grupos), dashboards: Number(l.dashboards), planilhas: Number(l.planilhas) };
}

/** Só para o teste automatizado: apaga tudo. Nunca chamar a partir do servidor. */
async function _limparParaTestes() {
    if (!/test/i.test(process.env.DB_NAME || '')) {
        throw new Error('_limparParaTestes só roda num banco cujo nome contém "test".');
    }
    for (const tabela of ['planilha_versao_partes', 'planilha_versoes', 'planilha_partes', 'planilhas', 'dashboard_versoes', 'dashboards', 'sessoes', 'usuarios', 'grupos']) {
        await consultar('DELETE FROM ' + tabela);
    }
}

module.exports = {
    iniciar, encerrar, configurado, pronto, explicarErroConexao, transacao, consultar,
    gerarHashSenha,
    listarUsuarios, acharUsuario, acharUsuarioPorLogin, criarUsuario, atualizarUsuario, removerUsuario,
    trocarPropriaSenha, atualizarPropriaConta,
    autenticar, usuarioDaSessao, encerrarSessao, limparSessoesVencidas, encerrarTodasSessoes,
    listarDashboards, acharDashboard, salvarDashboard, removerDashboard, removerDashboardDosGrupos,
    listarVersoes, restaurarVersao, duplicarDashboard,
    listarGrupos, acharGrupo, criarGrupo, atualizarGrupo, removerGrupo, contarUsuariosNoGrupo,
    listarPlanilhas, acharPlanilha, lerPlanilha, salvarPlanilha, removerPlanilha,
    listarVersoesPlanilha, lerVersaoPlanilha, restaurarVersaoPlanilha,
    permissoesDoUsuario, resumo,
    garantirAdmin, PAGINAS_CONTROLAVEIS, DURACAO_SESSAO_MS,
    _limparParaTestes
};
