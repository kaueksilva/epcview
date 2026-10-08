/**
 * Limite de tentativas de login.
 * ---------------------------------------------------------------------------
 * Sem isso, dá para testar senhas sem parar. Contamos os erros por login e por
 * IP, separadamente:
 *   - por login: protege a conta mesmo que o ataque venha de vários IPs;
 *   - por IP: segura quem tenta muitos logins diferentes a partir do mesmo lugar.
 * Passou do limite dentro da janela, aquela chave fica bloqueada por um tempo.
 * Acertar a senha zera o contador do login.
 *
 * Fica em memória: reiniciar o servidor zera os contadores, o que é aceitável —
 * o objetivo é tornar a força bruta lenta, não guardar histórico.
 */

const JANELA_MS = 15 * 60 * 1000;   // erros contam por 15 minutos
const BLOQUEIO_MS = 15 * 60 * 1000;  // e bloqueiam por 15 minutos
const MAX_POR_LOGIN = 5;
const MAX_POR_IP = 20;

function criarLimitador({ janelaMs = JANELA_MS, bloqueioMs = BLOQUEIO_MS, maxPorLogin = MAX_POR_LOGIN,
                          maxPorIp = MAX_POR_IP, agora = () => Date.now() } = {}) {
    const registros = new Map();   // chave -> { erros: [timestamps], bloqueadoAte }

    function registro(chave) {
        let r = registros.get(chave);
        if (!r) { r = { erros: [], bloqueadoAte: 0 }; registros.set(chave, r); }
        return r;
    }

    function chaves(login, ip) {
        return [
            { chave: 'login:' + String(login || '').trim().toLowerCase(), max: maxPorLogin },
            { chave: 'ip:' + String(ip || '?'), max: maxPorIp }
        ];
    }

    /** Quantos ms ainda faltam de bloqueio para este login/IP (0 = pode tentar). */
    function bloqueio(login, ip) {
        const t = agora();
        let resta = 0;
        for (const { chave } of chaves(login, ip)) {
            const r = registros.get(chave);
            if (r && r.bloqueadoAte > t) resta = Math.max(resta, r.bloqueadoAte - t);
        }
        return resta;
    }

    function falhou(login, ip) {
        const t = agora();
        for (const { chave, max } of chaves(login, ip)) {
            const r = registro(chave);
            r.erros = r.erros.filter(quando => t - quando < janelaMs);
            r.erros.push(t);
            if (r.erros.length >= max) { r.bloqueadoAte = t + bloqueioMs; r.erros = []; }
        }
    }

    function acertou(login) {
        registros.delete(chaves(login, null)[0].chave);
    }

    /** Joga fora o que já expirou, para o mapa não crescer para sempre. */
    function limpar() {
        const t = agora();
        for (const [chave, r] of registros) {
            if (r.bloqueadoAte <= t && r.erros.every(quando => t - quando >= janelaMs)) registros.delete(chave);
        }
    }

    return { bloqueio, falhou, acertou, limpar };
}

module.exports = { criarLimitador, MAX_POR_LOGIN };
