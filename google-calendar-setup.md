# Configuração Google Calendar API

## Passo 1: Criar Projeto no Google Cloud Console

1. Acesse https://console.cloud.google.com
2. Crie um novo projeto chamado "Agendamento de Aulas"
3. Vá para **APIs e serviços** → **Biblioteca**
4. Procure por "Google Calendar API" e ative

## Passo 2: Criar Credenciais OAuth 2.0

1. Acesse **APIs e serviços** → **Credenciais**
2. Clique em **Criar credenciais** → **ID do cliente OAuth**
3. Selecione **Aplicação Web**
4. Adicione URLs autorizadas:
   ```
   http://localhost:3000/api/google-callback
   https://seu-dominio.com/api/google-callback
   ```
5. Copie o **Client ID** e **Client Secret**

## Passo 3: Configurar as variáveis de ambiente

Adicione ao arquivo `.env`:

```
GOOGLE_CLIENT_ID=seu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=seu-client-secret
GOOGLE_CALENDAR_ID=primary
```

## Passo 4: Ativar a integração

1. Acesse seu site na seção de Administração
2. Clique na aba "Google Calendar"
3. Clique em "Conectar Google Calendar"
4. Autorize o acesso
5. Pronto! Os agendamentos aparecerão automaticamente

## Como funciona

- Quando um cliente confirma um agendamento após o pagamento, um evento é criado automaticamente
- O evento inclui:
  - Título: "Aula - Nome do Aluno"
  - Data e hora do agendamento
  - Local: endereço configurado
  - Descrição: categoria, número do aluno, etc.
  - Aviso: 30 minutos antes
