# 🍜 M.E.E. Gastronomia — mesas com cartão virtual

Sistema de salão com **duas interfaces**: a do **garçom** (abre as mesas e libera as
recargas) e a do **cliente** (recarrega o cartão e pede pela própria mesa).

O número da mesa **é** o número do cartão: cada mesa tem um cartão fixo, pré-pago e
recarregável. O cliente só pede enquanto houver saldo; o valor sai do cartão na hora.

## O fluxo

```
1. Garçom ABRE a mesa            → a mesa aparece como "Aberta" para o cliente
2. Cliente PEDE a recarga        → escolhe o valor e como vai pagar (nada entra ainda)
3. Garçom RECEBE e LIBERA        → só agora o saldo entra no cartão
4. Cliente PEDE pelo cardápio    → o valor sai do cartão na hora
5. Garçom FECHA a mesa           → devolve o saldo que sobrou
```

O cliente nunca credita saldo sozinho: ele só faz o pedido de recarga, e o dinheiro entra
no cartão no momento em que o garçom confirma que recebeu.

---

## Como rodar

Precisa apenas do **Node.js 22.5 ou superior** — não há nenhuma dependência para instalar.

```bash
npm start
```

Depois abra <http://localhost:3000>.

| Tela | Endereço | Para quem |
| --- | --- | --- |
| Portal | `/` | escolhe a interface |
| Garçom | `/garcom` | tablet ou celular do garçom |
| Cliente | `/cliente` | escolhe a mesa numa grade |
| Cliente | `/cliente?mesa=7` | vai direto para a mesa 7 |

**PINs de teste:** `1234` (Ester) · `4321` (Lucas).

> Para colocar no ar para os clientes, gere um QR Code por mesa apontando para
> `http://SEU-ENDERECO/cliente?mesa=N` e cole na mesa. O cliente abre a câmera e já cai
> direto no cartão dela. Sem QR Code, ele abre `/cliente` e toca na mesa onde está —
> a grade só mostra mesas que existem, então não há como digitar um número inválido.

Para começar do zero (apaga mesas, pedidos e extratos):

```bash
npm run reset
```

---

## O que cada interface faz

### Garçom (`/garcom`)

- **Recargas aguardando você** — o primeiro bloco da tela. Cada card mostra a mesa, **quem
  pediu**, o valor e como o cliente vai pagar. `✓ Recebi, liberar` credita o cartão;
  `Recusar` descarta.
  O contador pulsa em vermelho enquanto houver pendência, e a mesa correspondente ganha
  uma faixa na grade.
- **Números do salão** — mesas ocupadas, saldo total em cartões, consumo do dia, fila de
  pedidos e recargas a liberar.
- **Mesas** — grade com status, saldo e tempo de abertura. Mesa sem saldo fica destacada.
- **Abrir / fechar mesa** — abrir é o que libera a mesa para o cliente usar. Ao fechar, o
  sistema avisa quanto de saldo sobrou para devolver e bloqueia se ainda houver pedido em
  aberto (dá para forçar).
- **Recarga manual** — dentro da mesa, para o cliente que não quer usar o celular. É o
  único caminho em que o garçom lança o valor direto.
- **Fila de pedidos** — avança `recebido → preparando → pronto → entregue`. Cancelar um
  pedido **estorna** o valor no cartão automaticamente.
- **Cardápio** — adiciona itens e marca/desmarca "esgotado" em tempo real.

### Cliente (`/cliente`)

- **Escolha da mesa** numa grade com todas as mesas reais, marcando quais já foram abertas
  pelo garçom. Não existe campo de digitar número, então não há como escolher uma mesa
  inexistente.
- **Boas-vindas** com o número da mesa em tamanho grande ("você está na mesa 04") e o
  campo de nome. O nome fica no cabeçalho junto da mesa e acompanha cada pedido e cada
  recarga, para o garçom saber quem chamou. Fica guardado por mesa no próprio navegador:
  quem volta à mesma mesa não digita de novo, e quem troca de mesa recebe o último nome
  já preenchido.
- **← Trocar de mesa** no topo, para voltar à grade sem precisar mexer no endereço.
- **Cartão virtual** com número da mesa, saldo e consumo.
- **Recarregar cartão** — escolhe o valor e a forma de pagamento; o pedido fica aguardando
  o garçom, e dá para cancelar enquanto ele não decidir. O botão só aparece com a mesa
  aberta.
- **Cardápio** por categorias, com contador de quantidade. O botão `+` trava sozinho quando
  o saldo não cobre mais um item — o cliente nunca monta um pedido que não pode pagar.
- **Envio do pedido** com observação para a cozinha e conferência do saldo que vai restar.
- **Meus pedidos** com o status ao vivo e **Extrato** de tudo que entrou e saiu do cartão.

As duas telas se atualizam sozinhas: o cliente vê a mesa ser aberta e a recarga cair no
cartão sem recarregar a página, e o garçom vê o pedido de recarga e o pedido de comida
chegarem na hora.

---

## Estrutura

```
server.js          API + servidor de arquivos + eventos em tempo real (SSE)
db.js              Esquema do banco e dados iniciais (cardápio, 12 mesas, garçons)
data/              Banco SQLite gerado na primeira execução
public/
  index.html       Portal
  garcom.html      Interface do garçom
  cliente.html     Interface do cliente
  css/style.css    Estilo e paleta da casa
  js/comum.js      Dinheiro, chamadas à API, avisos e tempo real
  js/garcom.js
  js/cliente.js
```

### Banco de dados

**SQLite**, pelo módulo `node:sqlite` que já vem no Node — o arquivo fica em
`data/restaurante.db` e pode ser aberto em qualquer visualizador de SQLite.

| Tabela | Guarda |
| --- | --- |
| `mesas` | número (= cartão), status, **saldo**, lugares, quem abriu |
| `cardapio` | itens, preço, categoria, disponibilidade |
| `pedidos` / `pedido_itens` | pedidos, as linhas de cada um e o nome de quem pediu |
| `recargas` | pedidos de recarga do cliente, com o nome, e a decisão do garçom |
| `transacoes` | extrato do cartão: recarga, consumo, estorno, devolução |
| `garcons` / `sessoes` | quem pode entrar na área do garçom |

**Todo valor é guardado em centavos, como número inteiro** — é o que evita o erro clássico
de arredondamento de dinheiro em ponto flutuante. A formatação em `R$` acontece só na tela.

Cada movimento do cartão vira uma linha em `transacoes` com o saldo resultante, então o
extrato sempre fecha com o saldo da mesa.

---

## API

Rotas marcadas com 🔒 exigem o token do garçom (`Authorization: Bearer ...`).

| Método | Rota | O que faz |
| --- | --- | --- |
| `POST` | `/api/login` | entra com o PIN e devolve o token |
| `GET` | 🔒 `/api/mesas` | lista as mesas com saldo e consumo |
| `GET` | `/api/mesas-abertas` | lista enxuta para o cliente escolher (sem saldos) |
| `GET` | `/api/mesas/:n` | mesa + pedidos + extrato + recarga pendente |
| `POST` | 🔒 `/api/mesas/:n/abrir` · `/fechar` | abre / fecha a mesa |
| `POST` | `/api/mesas/:n/recarga-pedido` | cliente pede a recarga (não credita) |
| `POST` | `/api/recargas/:id/cancelar` | cliente desiste do pedido |
| `GET` | 🔒 `/api/recargas` | recargas esperando liberação |
| `POST` | 🔒 `/api/recargas/:id/liberar` · `/recusar` | **credita** ou descarta |
| `POST` | 🔒 `/api/mesas/:n/recarga` | recarga lançada direto pelo garçom |
| `GET` | `/api/cardapio` | itens disponíveis (`?todos=1` traz os esgotados) |
| `POST` | `/api/pedidos` | cria o pedido e debita do cartão |
| `PATCH` | 🔒 `/api/pedidos/:id/status` | muda o status (cancelar estorna) |
| `GET` | `/api/resumo` | números do salão |
| `GET` | `/api/stream` | eventos em tempo real (SSE) |

---

## Antes de usar em um restaurante de verdade

O sistema está completo e funcional, mas foi feito para rodar na rede do restaurante. Se for
abrir para a internet, vale ajustar três pontos:

1. **PIN em texto puro** — hoje o PIN é comparado direto no banco. Use um hash (bcrypt/argon2).
2. **Sem HTTPS** — coloque atrás de um proxy com TLS (Caddy, nginx) antes de expor.
3. **Qualquer um que saiba o número da mesa vê o cartão dela** — é o comportamento desejado
   para o QR Code na mesa, mas se quiser restringir, dá para exigir um código que o garçom
   informa ao abrir a mesa. Pelo mesmo motivo, qualquer pessoa pode *pedir* uma recarga
   numa mesa aberta — o que é inofensivo, já que nada entra no cartão sem o garçom liberar.
