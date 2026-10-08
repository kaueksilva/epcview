/**
 * Portões de acesso — as mesmas checagens que toda rota de dashboards e
 * páginas usa antes de responder. Ficam fora do server.js de propósito:
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

module.exports = { listaPermite, podeVerPagina, podeVerDashboard };
