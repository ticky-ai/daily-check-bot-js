### Шаг 1: Установка зависимостей

```bash
npm install
# или
yarn install
```

### Шаг 2: Настройка базы данных

Создайте базу данных PostgreSQL:

```sql
CREATE DATABASE daily_check_bot;
```

### Шаг 3: Настройка переменных окружения

Создайте файл `.env` в корне проекта:

```env
# ============================================
# ОБЯЗАТЕЛЬНЫЕ ПЕРЕМЕННЫЕ
# ============================================

# Токен Telegram бота (получить у @BotFather)
BOT_TOKEN=your_bot_token_here

# URL подключения к базе данных PostgreSQL
DATABASE_URL=postgresql://user:password@localhost:5432/daily_check_bot

# ============================================
# OPENAI (для AI-функций)
# ============================================

# API ключ OpenAI (опционально, но рекомендуется)
# Получить можно на https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-your_openai_api_key_here


# ============================================
# ОПЦИОНАЛЬНЫЕ ПЕРЕМЕННЫЕ
# ============================================

# Режим работы приложения (development/production)
NODE_ENV=development

# Порт для запуска приложения (по умолчанию 3000)
PORT=3000

# Уровень логирования (error/warn/info/debug)
LOG_LEVEL=info

# Имя бота (по умолчанию TickyAIBot)
BOT_USERNAME=YourBotName

# URL для webhook (если используете webhook вместо polling)
WEBHOOK_URL=https://yourdomain.com/webhook

# ============================================
# ПЛАТЕЖИ (ЮKassa)
# ============================================

# ID магазина в ЮKassa (для платежей)
YOOKASSA_SHOP_ID=your_shop_id

# Секретный ключ ЮKassa
YOOKASSA_SECRET_KEY=your_secret_key

# ============================================
# REDIS (для кэширования, опционально)
# ============================================

# URL подключения к Redis
REDIS_URL=redis://localhost:6379

# ============================================
# АДМИНИСТРИРОВАНИЕ
# ============================================

# ID администраторов (через запятую)
# Узнать свой ID можно у @userinfobot
ADMIN_IDS=123456789,987654321

# Telegram для поддержки (по умолчанию @Gexxx1)
SUPPORT_TELEGRAM=@your_support_username
```

### Шаг 4: Настройка базы данных с помощью Prisma

```bash
# Генерация Prisma Client
npm run prisma:generate

# Применение миграций
npm run prisma:migrate
```

### Шаг 5: Запуск проекта

#### Режим разработки (development)
```bash
npm run start:dev
```

#### Режим production
```bash
# Сборка проекта
npm run build

# Запуск
npm run start:prod
```

#### С применением миграций (production)
```bash
npm run start:migrate:prod
```

## Запуск с Docker

### Использование Docker Compose

1. Создайте файл `.env` (см. выше)

2. Обновите переменные для PostgreSQL в `.env`:
```env
POSTGRES_DB=daily_check_bot
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_password
POSTGRES_PORT=5432
```

3. Запустите контейнеры:
```bash
docker-compose up -d
```

4. Примените миграции:
```bash
docker-compose exec backend npm run prisma:migrate
```

## Как использовать бота

### Первый запуск

1. Найдите вашего бота в Telegram по имени
2. Отправьте команду `/start`
3. Бот попросит выбрать часовой пояс - выберите ваш регион

### Основные команды

- `/start` - Запустить бота и показать главное меню
- `/menu` - Показать главное меню

Пример:
```
DATABASE_URL=postgresql://postgres:mypassword@localhost:5432/daily_check_bot
```

### OPENAI_API_KEY (Рекомендуется)
API ключ OpenAI для работы AI-функций:
1. Зарегистрируйтесь на [platform.openai.com](https://platform.openai.com)
2. Перейдите в API Keys
3. Создайте новый ключ
4. Скопируйте в `.env`

**Примечание:** Без этого ключа некоторые функции AI будут недоступны.

### YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY
Для работы платежной системы:
1. Зарегистрируйтесь в [ЮKassa](https://yookassa.ru)
2. Создайте магазин
3. Скопируйте Shop ID и Secret Key

### ADMIN_IDS
ID администраторов через запятую:
```
ADMIN_IDS=123456789,987654321
```

**Как узнать свой ID:**
- Отправьте `/start` боту [@userinfobot](https://t.me/userinfobot)
- Или используйте /myid 

## Решение проблем

### Бот не отвечает

1. Проверьте, что `BOT_TOKEN` указан правильно
2. Убедитесь, что бот запущен: `npm run start:dev`
3. Проверьте логи на наличие ошибок

### Ошибка подключения к базе данных

1. Убедитесь, что PostgreSQL запущен
2. Проверьте `DATABASE_URL` в `.env`
3. Проверьте, что база данных создана
4. Примените миграции: `npm run prisma:migrate`

### Ошибки при применении миграций

```bash
# Сброс базы данных (ОСТОРОЖНО: удалит все данные!)
npx prisma migrate reset

# Применение миграций заново
npm run prisma:migrate
```

### AI функции не работают

1. Проверьте, что `OPENAI_API_KEY` указан в `.env`
2. Убедитесь, что у вас есть кредиты на аккаунте OpenAI
3. Проверьте логи на наличие ошибок

## Мониторинг и логи

Логи приложения можно найти в консоли при запуске. Для production рекомендуется настроить внешнюю систему логирования (например, Winston с отправкой в облако).

## Безопасность

1. **Никогда не коммитьте `.env` файл в Git**
2. Используйте сильные пароли для базы данных
3. Ограничьте доступ к серверу только необходимым портам
4. Регулярно обновляйте зависимости: `npm update`

## Поддержка

Если у вас возникли вопросы или проблемы:
- Telegram: [@Gexxx1](https://t.me/Gexxx1) (по умолчанию)
- Или измените `SUPPORT_TELEGRAM` в `.env`

## Деплой в production

В принципе все
