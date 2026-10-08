'use strict';

/** Limite de tentativas de login: bloqueia a força bruta sem travar quem acerta. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarLimitador } = require('../lib/limite');

function relogio() {
    let t = 1_000_000;
    return { agora: () => t, avancar: ms => { t += ms; } };
}

test('5 erros no mesmo login bloqueiam esse login por 15 minutos', () => {
    const r = relogio();
    const lim = criarLimitador({ agora: r.agora });
    for (let i = 0; i < 4; i++) lim.falhou('ana', '1.1.1.1');
    assert.equal(lim.bloqueio('ana', '1.1.1.1'), 0);
    lim.falhou('ana', '1.1.1.1');
    assert.equal(lim.bloqueio('ana', '1.1.1.1'), 15 * 60 * 1000);
    // o bloqueio é do login: de outro IP continua bloqueado
    assert.ok(lim.bloqueio('ANA', '2.2.2.2') > 0);
    // outro login no mesmo IP segue liberado (o IP só tem 5 erros de 20)
    assert.equal(lim.bloqueio('bruno', '1.1.1.1'), 0);
    r.avancar(15 * 60 * 1000);
    assert.equal(lim.bloqueio('ana', '1.1.1.1'), 0);
});

test('erros antigos saem da janela e não somam', () => {
    const r = relogio();
    const lim = criarLimitador({ agora: r.agora });
    for (let i = 0; i < 4; i++) lim.falhou('ana', 'ip');
    r.avancar(16 * 60 * 1000);
    lim.falhou('ana', 'ip');
    assert.equal(lim.bloqueio('ana', 'ip'), 0);
});

test('acertar a senha zera os erros do login', () => {
    const lim = criarLimitador({ agora: relogio().agora });
    for (let i = 0; i < 4; i++) lim.falhou('ana', 'ip');
    lim.acertou('ana');
    lim.falhou('ana', 'ip');
    assert.equal(lim.bloqueio('ana', 'ip'), 0);
});

test('muitos logins diferentes do mesmo IP bloqueiam o IP', () => {
    const lim = criarLimitador({ agora: relogio().agora });
    for (let i = 0; i < 20; i++) lim.falhou('usuario' + i, '9.9.9.9');
    assert.ok(lim.bloqueio('qualquer', '9.9.9.9') > 0);
    assert.equal(lim.bloqueio('qualquer', '8.8.8.8'), 0);
});
