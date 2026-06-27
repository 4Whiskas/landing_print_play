# Print&Play — лендинг

Одностраничный сайт студии 3D-печати с формой заявки. Заявки уходят на почту
через **Unisender Go**. Бэкенд — один файл на Node.js **без зависимостей**
(`npm install` не нужен).

## Состав

| Файл | Назначение |
|------|------------|
| `index.html` | Сама страница (вся вёрстка и логика формы внутри) |
| `server.js` | Мини-сервер: отдаёт сайт + принимает заявки + шлёт письмо |
| `config.example.json` | Шаблон настроек — скопируйте в `config.json` |
| `printplay.service` | Юнит для автозапуска через systemd |
| `assets/` | Картинки |
| `uploads/` | Копии фото из заявок — только если `saveUploads: true` (иначе не создаётся) |
| `leads.log` | Резервная копия текста заявок (создаётся автоматически) |

---

## Быстрый старт локально (проверить, что всё работает)

1. Установите Node.js (любая LTS-версия 18+).
2. В папке `site/` выполните:
   ```
   node server.js
   ```
3. Откройте http://localhost:8080 — страница работает. Без `config.json`
   заявки не уходят почтой, а **пишутся в `leads.log`** (удобно для теста формы).

---

## Развёртывание на VPS (Linux)

Нужно установить только **Node.js**. Больше ничего.

```bash
# 1. Node.js (пример для Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Загрузите папку site/ на сервер, например в /var/www/printplay
#    (через scp, rsync, git — как удобно)

# 3. Создайте config.json из шаблона и впишите данные Unisender (см. ниже)
cd /var/www/printplay
cp config.example.json config.json
nano config.json

# 4. Проверьте запуск вручную
node server.js          # должно написать "сервер запущен", Ctrl+C для выхода

# 5. Автозапуск через systemd
sudo cp printplay.service /etc/systemd/system/
sudo nano /etc/systemd/system/printplay.service   # проверьте пути и User
sudo systemctl daemon-reload
sudo systemctl enable --now printplay
sudo systemctl status printplay                   # должно быть active (running)
```

### HTTPS и домен

Сервер слушает порт `8080` по HTTP. Наружу его правильно выставлять через
обратный прокси с сертификатом. Если у вас уже есть **nginx**:

```nginx
server {
    server_name вашдомен.ru;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 35m;   # чтобы проходили фото
    }
}
```
Затем сертификат: `sudo certbot --nginx -d вашдомен.ru`.

> Без своего веб-сервера можно поставить **Caddy** — он сам получает сертификат:
> в `Caddyfile` достаточно `вашдомен.ru { reverse_proxy 127.0.0.1:8080 }`.

После изменений: `sudo systemctl restart printplay`.

---

## Настройка Unisender Go

Используется **Unisender Go** — сервис транзакционной почты (метод `email/send`,
эндпоинт `goapi.unisender.ru`, ключ в заголовке `X-API-KEY`).
В `config.json` нужно заполнить:

| Поле | Что это |
|------|---------|
| `apiKey` | API-ключ Unisender Go (Настройки → API-ключи) |
| `senderEmail` | Адрес отправителя на **подтверждённом домене** (напр. `zakaz@printplay.tech`) |
| `recipientEmail` | Куда слать заявки (ваша почта; можно несколько через запятую) |
| `saveUploads` | `false` (по умолчанию) — фото не пишутся на диск, уходят только вложением |

Секреты можно держать не в файле, а в переменных окружения (см. `printplay.service`).
Переменные окружения имеют приоритет над `config.json`.

### Что важно знать про Unisender Go

- **Нужен активный тариф.** Без подключённого тарифа API возвращает 403. Первые
  2 месяца бесплатно (6000 писем/мес), далее — по тарифу.
- **Домен нужно подтвердить** DNS-записями (SPF, DKIM, validate-hash, DMARC) из
  кабинета. Без этого отправка от `senderEmail` не заработает; адрес — на этом домене.
- Нельзя слать «от» бесплатных почт (gmail, yandex, mail.ru) — только со своего домена.
- **Фото уходят вложениями** прямо в письме (лимит письма — 10 МБ).
- **Диск не растёт:** при `saveUploads: false` фото на сервере не сохраняются.
  Поставьте `true`, если хотите держать копии фото в `uploads/` (за счёт места).
- Текст каждой заявки в любом случае дублируется в `leads.log`.

---

## Как это работает

1. Посетитель заполняет форму. Фото в браузере **сжимаются** (макс. сторона
   1280px, JPEG) — на сервер уходит немного данных.
2. `server.js` отправляет письмо вам через Unisender Go: текст заявки + фото
   **вложениями**. Фото на сервере не сохраняются (при `saveUploads: false`).
3. Текст заявки пишется в `leads.log` — даже если почта временно недоступна,
   заявка не теряется.

## Защита от спама

Встроен простой лимит: не больше 20 заявок с одного IP в час. При необходимости
поправьте в `server.js` (функция `rateLimited`).
