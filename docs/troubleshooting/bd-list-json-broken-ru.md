# bd list --json не работает в v0.59

## Симптомы

```bash
bd list --json
# Выводит обычный текст вместо JSON
# Флаг --json молча игнорируется
```

Любая автоматизация, которая парсит JSON-вывод `bd list`, ломается.

## Причина

Баг в bd v0.59.0. Флаг `--json` принимается парсером аргументов, но не влияет на формат вывода.

## Обходные пути

### Вариант 1: bd sql (рекомендуется)

```bash
# Все open issues
bd sql "SELECT id, title, status, priority FROM issues WHERE status = 'open'"

# Все issues в JSON-подобном формате
bd sql "SELECT * FROM issues WHERE status = 'open'"

# Количество по статусам
bd sql "SELECT status, COUNT(*) FROM issues GROUP BY status"
```

`bd sql` возвращает табличный формат. Не JSON, но стабильный и парсируемый.

### Вариант 2: bd show с конкретным ID

```bash
bd show myproject-a1b --json
# --json может работать для show (зависит от версии)
```

### Вариант 3: прямой SQL через Dolt

Если нужен настоящий JSON и установлен mysql CLI:

```bash
mysql -h 127.0.0.1 -P $(cat .beads/dolt-server.port) -u root -e \
  "SELECT JSON_OBJECT('id', id, 'title', title, 'status', status) FROM issues WHERE status = 'open'" \
  $(cat .beads/metadata.json | jq -r '.dolt_database')
```

## Статус

Баг. Исправление ожидается в следующих версиях bd.

Atelier обходит эту проблему: читает данные напрямую из Dolt через SQL, минуя bd CLI.
