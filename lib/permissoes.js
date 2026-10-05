/**
 * Portões de acesso — as mesmas checagens que toda rota de dashboards, páginas
 * e aplicações usa antes de responder. Ficam fora do server.js de propósito:
 * server.js sobe um servidor de verdade ao ser importado (server.listen), o
 * que impediria testar esta lógica sem abrir uma porta de rede.
 */

const db = require('./db');

/** 'todos' libera geral; senão, só quem está na lista (por id ou pelo curinga '*'). */
function listaPermite(lista, valor) {
    return lista === 'todos' || (Array.isArray(lista) && (lista.includes('*') || lista.includes(valor)));
}

function podeVerPagina(usuario, chave) {
    if (!usuario) return false;
    if (usuario.papel === 'admin') return true;
    return listaPermite(db.permissoesDoUsuario(usuario).paginas, chave);
}

function podeVerDashboard(usuario, dashboardId) {
    if (!usuario) return false;
    if (usuario.papel === 'admin') return true;
    return listaPermite(db.permissoesDoUsuario(usuario).dashboards, dashboardId);
}

function podeAbrirApp(usuario, app) {
    if (!usuario) return false;
    if (usuario.papel === 'admin') return true;
    const permitidos = Array.isArray(app.gruposPermitidos) ? app.gruposPermitidos : [];
    if (permitidos.includes('*')) return true;   // qualquer usuário logado
    return Boolean(usuario.grupoId) && permitidos.includes(usuario.grupoId);
}

module.exports = { listaPermite, podeVerPagina, podeVerDashboard, podeAbrirApp };
