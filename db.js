'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'restaurante.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS garcons (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  nome     TEXT NOT NULL,
  pin      TEXT NOT NULL,
  ativo    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessoes (
  token     TEXT PRIMARY KEY,
  garcom_id INTEGER NOT NULL REFERENCES garcons(id),
  criado_em TEXT NOT NULL
);

-- O numero da mesa E o numero do cartao virtual. Cartao fixo, saldo recarregavel.
CREATE TABLE IF NOT EXISTS mesas (
  numero     INTEGER PRIMARY KEY,
  apelido    TEXT,
  lugares    INTEGER NOT NULL DEFAULT 4,
  status     TEXT NOT NULL DEFAULT 'livre',   -- livre | ocupada
  saldo      INTEGER NOT NULL DEFAULT 0,      -- em centavos
  aberta_em  TEXT,
  garcom_id  INTEGER REFERENCES garcons(id)
);

CREATE TABLE IF NOT EXISTS cardapio (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nome        TEXT NOT NULL,
  descricao   TEXT NOT NULL DEFAULT '',
  categoria   TEXT NOT NULL,
  preco       INTEGER NOT NULL,               -- em centavos
  emoji       TEXT NOT NULL DEFAULT '🍜',
  disponivel  INTEGER NOT NULL DEFAULT 1,
  ordem       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pedidos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mesa        INTEGER NOT NULL REFERENCES mesas(numero),
  status      TEXT NOT NULL DEFAULT 'recebido', -- recebido | preparando | pronto | entregue | cancelado
  total       INTEGER NOT NULL,
  observacao  TEXT NOT NULL DEFAULT '',
  cliente_nome TEXT NOT NULL DEFAULT '',        -- quem pediu, para o garcom saber
  origem      TEXT NOT NULL DEFAULT 'cliente',  -- cliente | garcom
  criado_em   TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pedido_itens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id  INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  item_id    INTEGER REFERENCES cardapio(id),
  nome       TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '🍜',
  preco_unit INTEGER NOT NULL,
  qtd        INTEGER NOT NULL
);

-- Pedidos de recarga feitos pelo cliente na mesa. So viram saldo depois que
-- o garcom recebe o dinheiro e libera.
CREATE TABLE IF NOT EXISTS recargas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mesa        INTEGER NOT NULL REFERENCES mesas(numero),
  valor       INTEGER NOT NULL,                 -- em centavos
  forma_pgto  TEXT NOT NULL DEFAULT 'dinheiro',
  cliente_nome TEXT NOT NULL DEFAULT '',        -- quem pediu a recarga
  status      TEXT NOT NULL DEFAULT 'pendente', -- pendente | liberada | recusada | cancelada
  criado_em   TEXT NOT NULL,
  decidido_em TEXT,
  garcom_id   INTEGER REFERENCES garcons(id)
);

CREATE INDEX IF NOT EXISTS idx_recargas_status ON recargas(status);

-- Extrato do cartao virtual
CREATE TABLE IF NOT EXISTS transacoes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mesa       INTEGER NOT NULL REFERENCES mesas(numero),
  tipo       TEXT NOT NULL,                    -- recarga | consumo | estorno | devolucao
  valor      INTEGER NOT NULL,                 -- positivo entra, negativo sai
  saldo_apos INTEGER NOT NULL,
  descricao  TEXT NOT NULL DEFAULT '',
  forma_pgto TEXT,
  pedido_id  INTEGER REFERENCES pedidos(id),
  garcom_id  INTEGER REFERENCES garcons(id),
  criado_em  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pedidos_mesa   ON pedidos(mesa);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_trans_mesa     ON transacoes(mesa);
`);

// -------------------------------------------------------------------- migração

// Bancos criados antes do campo de nome do cliente continuam funcionando.
function garantirColuna(tabela, coluna, definicao) {
  const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all();
  if (!colunas.some((c) => c.name === coluna)) {
    db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
  }
}

garantirColuna('pedidos', 'cliente_nome', "TEXT NOT NULL DEFAULT ''");
garantirColuna('recargas', 'cliente_nome', "TEXT NOT NULL DEFAULT ''");

// ---------------------------------------------------------------- seed inicial

function seed() {
  const temGarcom = db.prepare('SELECT COUNT(*) AS n FROM garcons').get().n;
  if (!temGarcom) {
    const ins = db.prepare('INSERT INTO garcons (nome, pin) VALUES (?, ?)');
    ins.run('Ester', '1234');
    ins.run('Lucas', '4321');
  }

  const temMesa = db.prepare('SELECT COUNT(*) AS n FROM mesas').get().n;
  if (!temMesa) {
    const ins = db.prepare('INSERT INTO mesas (numero, lugares) VALUES (?, ?)');
    for (let n = 1; n <= 12; n++) ins.run(n, n <= 8 ? 4 : 6);
  }

  const temItem = db.prepare('SELECT COUNT(*) AS n FROM cardapio').get().n;
  if (!temItem) {
    const ins = db.prepare(
      'INSERT INTO cardapio (nome, descricao, categoria, preco, emoji, ordem) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const itens = [
      ['Lámen Shoyu',      'Caldo de shoyu, chashu, ovo marinado e cebolinha',        'Lámen',      4200, '🍜', 1],
      ['Lámen Picante',    'Caldo apimentado, carne desfiada e broto de feijão',      'Lámen',      4600, '🌶️', 2],
      ['Lámen Vegetariano','Caldo de missô branco, tofu grelhado e shimeji',          'Lámen',      3900, '🥬', 3],
      ['Yakisoba de Carne','Macarrão salteado com legumes e tiras de carne',          'Lámen',      3800, '🍝', 4],
      ['Gyoza (6 un)',     'Pastelzinho japonês de porco com molho de gergelim',      'Entradas',   2600, '🥟', 5],
      ['Harumaki (4 un)',  'Rolinho crocante de legumes',                             'Entradas',   2200, '🥢', 6],
      ['Edamame',          'Vagem de soja no vapor com flor de sal',                  'Entradas',   1800, '🫛', 7],
      ['Tempurá Misto',    'Camarão e legumes empanados leves',                       'Entradas',   3400, '🍤', 8],
      ['Sushi Combo 12',   'Seleção do chef com 12 peças variadas',                   'Sushi',      5900, '🍣', 9],
      ['Uramaki Salmão',   '8 peças com cream cheese e cebolinha',                    'Sushi',      3600, '🍣', 10],
      ['Hot Roll (8 un)',  'Empanado crocante com geleia de pimenta',                 'Sushi',      3200, '🔥', 11],
      ['Guaraná Japonês',  'Lata 350ml gelada',                                       'Bebidas',     900, '🥤', 12],
      ['Chá Verde Gelado', 'Matchá gelado sem açúcar, 400ml',                          'Bebidas',    1200, '🍵', 13],
      ['Cerveja Long Neck','Pilsen 355ml',                                            'Bebidas',    1400, '🍺', 14],
      ['Água com Gás',     'Garrafa 500ml',                                           'Bebidas',     700, '💧', 15],
      ['Mochi (3 un)',     'Sorvete japonês nos sabores do dia',                      'Sobremesas', 2400, '🍡', 16],
      ['Cheesecake Yuzu',  'Fatia cremosa com calda cítrica',                         'Sobremesas', 2800, '🍰', 17],
    ];
    for (const i of itens) ins.run(...i);
  }
}

seed();

module.exports = db;
