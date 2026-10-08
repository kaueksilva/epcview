/**
 * EPCVIEW - contato do site
 * ---------------------------------------------------------------------------
 * ÚNICO lugar para trocar o e-mail e o WhatsApp. Valem para o site público e
 * para o link "Solicite uma demonstração" do login.
 *
 * Os valores abaixo são PROVISÓRIOS — troque pelos reais:
 *   email     endereço que recebe os pedidos
 *   whatsapp  só números, com 55 + DDD + número (ex.: 5511912345678)
 *   mensagem  texto que já vem escrito ao abrir a conversa
 *
 * Nas páginas, marque o link com data-contato="whatsapp" ou "email" e o
 * endereço é preenchido aqui. data-contato-texto="email" mostra o e-mail
 * escrito no elemento.
 */
(function () {
    'use strict';

    const CONTATO = {
        email: 'contato@example.com',
        whatsapp: '5500000000000',
        mensagem: 'Olá! Gostaria de conhecer o EPCVIEW e solicitar uma demonstração.'
    };

    const links = {
        whatsapp: 'https://wa.me/' + CONTATO.whatsapp + '?text=' + encodeURIComponent(CONTATO.mensagem),
        email: 'mailto:' + CONTATO.email + '?subject=' + encodeURIComponent('Demonstração do EPCVIEW')
    };

    function aplicar() {
        document.querySelectorAll('[data-contato]').forEach(el => {
            const tipo = el.getAttribute('data-contato');
            if (!links[tipo]) return;
            el.href = links[tipo];
            if (tipo === 'whatsapp') {
                el.target = '_blank';
                el.rel = 'noopener';
            }
        });
        document.querySelectorAll('[data-contato-texto="email"]').forEach(el => { el.textContent = CONTATO.email; });
    }

    // Carregado no fim do <body>, antes do site.js: os links já existem e
    // precisam estar preenchidos quando o site.js ler os do menu.
    aplicar();
})();
