// server/routes/privacy.ts — página pública da Política de Privacidade.
//
// Exigida pela App Store (URL de privacy policy no App Store Connect) e
// pela LGPD (transparência ao titular). Servida pelo próprio Express em
// GET /privacidade (alias /privacy) — sem dependência do bundle web.

import { Router, type Request, type Response } from "express";

export const privacyRouter = Router();

const UPDATED_AT = "19 de agosto de 2026";

const HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidade — Escala+</title>
<style>
  :root { --navy: #00354F; --ink: #1e293b; --muted: #64748b; --line: #e2e8f0; --bg: #f8fafc; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--ink); line-height: 1.65; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 48px 20px 80px; }
  header { border-bottom: 3px solid var(--navy); padding-bottom: 20px; margin-bottom: 32px; }
  h1 { color: var(--navy); font-size: 28px; }
  .updated { color: var(--muted); font-size: 14px; margin-top: 6px; }
  h2 { color: var(--navy); font-size: 19px; margin: 32px 0 10px; }
  p, li { font-size: 15.5px; margin-bottom: 10px; }
  ul { padding-left: 22px; margin-bottom: 12px; }
  strong { color: var(--navy); }
  table { width: 100%; border-collapse: collapse; margin: 12px 0 16px; font-size: 14.5px; }
  th, td { text-align: left; padding: 9px 12px; border: 1px solid var(--line); vertical-align: top; }
  th { background: #eef4f8; color: var(--navy); }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
  a { color: var(--navy); }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Política de Privacidade — Escala+</h1>
  <div class="updated">Última atualização: ${UPDATED_AT}</div>
</header>

<h2>1. Quem somos</h2>
<p>O Escala+ é um aplicativo de gestão de escalas de plantão para equipes médicas hospitalares. O controlador dos dados é o operador da plataforma Escala+/Comunica+ ("nós"). Contato do controlador: <a href="mailto:renosilveira@gmail.com">renosilveira@gmail.com</a>.</p>

<h2>2. Quais dados tratamos</h2>
<p>O Escala+ trata exclusivamente dados de <strong>profissionais de saúde</strong> no contexto do seu trabalho. <strong>O aplicativo não coleta, armazena ou processa dados de pacientes.</strong></p>
<ul>
  <li><strong>Dados cadastrais</strong>: nome, e-mail profissional, especialidade/serviço, cargo e vínculo institucional.</li>
  <li><strong>Credenciais</strong>: senha armazenada exclusivamente como hash criptográfico (bcrypt); a senha em texto claro nunca é gravada nem trafega além do ato de autenticação sob TLS.</li>
  <li><strong>Dados operacionais</strong>: escalas de plantão, alocações, confirmações de presença, trocas e substituições, registros de auditoria das ações realizadas no sistema (autor, ação, data/hora).</li>
  <li><strong>Token de notificação push</strong>: identificador técnico do aparelho (via Expo/APNs) usado apenas para entregar notificações de plantão.</li>
</ul>
<p>O Escala+ <strong>não coleta</strong>: localização, contatos, fotos, microfone, dados de saúde, identificadores de publicidade. <strong>Não exibimos anúncios, não usamos rastreadores de terceiros e não vendemos dados</strong> — em nenhuma hipótese.</p>

<h2>3. Para que usamos (finalidade e base legal — LGPD)</h2>
<table>
  <tr><th>Uso</th><th>Base legal (Lei 13.709/2018)</th></tr>
  <tr><td>Autenticação e operação da escala (alocações, confirmações, trocas)</td><td>Execução de contrato/procedimentos preliminares (art. 7º, V) e legítimo interesse na organização do serviço médico (art. 7º, IX)</td></tr>
  <tr><td>Notificações de confirmação de plantão</td><td>Legítimo interesse; podem ser desativadas nas configurações do aparelho</td></tr>
  <tr><td>Registros de auditoria</td><td>Legítimo interesse e cumprimento de obrigações de gestão do serviço</td></tr>
  <tr><td>Integração com o Comunica+ (item 4)</td><td>Execução de contrato — mesma plataforma operacional</td></tr>
</table>

<h2>4. Integração com o Comunica+</h2>
<p>O Escala+ integra-se ao Comunica+ (aplicativo de comunicação hospitalar da mesma plataforma) para: (a) <strong>login único (SSO)</strong> — o acesso é transferido por token criptográfico assinado (RS256) de uso único e validade de 90 segundos, sem trânsito de senha; (b) <strong>declaração automática de plantonista</strong> — ao confirmar presença, o Escala+ informa ao Comunica+ nome do serviço, tipo e janela do plantão do profissional. Nenhum dado adicional é compartilhado.</p>

<h2>5. Onde os dados ficam (operadores)</h2>
<p>Infraestrutura contratada sob acordos de processamento dos respectivos provedores: hospedagem da aplicação (Render), banco de dados gerenciado com criptografia em trânsito (DigitalOcean Managed MySQL), entrega de notificações (Expo Push/Apple APNs). Os servidores localizam-se nos EUA; a transferência internacional ampara-se no art. 33 da LGPD, com salvaguardas contratuais dos provedores.</p>

<h2>6. Retenção e eliminação</h2>
<p>Dados cadastrais e operacionais são mantidos enquanto durar o vínculo do profissional com a instituição, e registros de auditoria pelo prazo necessário à gestão e defesa em processos (art. 16). Contas recusadas no cadastro são eliminadas imediatamente.</p>

<h2>7. Seus direitos (art. 18, LGPD)</h2>
<p>O profissional pode solicitar, a qualquer tempo: confirmação de tratamento, acesso, correção, anonimização, portabilidade, eliminação dos dados e informação sobre compartilhamentos — pelo e-mail do controlador (item 1), com resposta nos prazos legais. A exclusão da conta pode ser solicitada pelo mesmo canal.</p>

<h2>8. Segurança</h2>
<p>TLS em todas as comunicações; senhas com hash bcrypt; sessões com tokens assinados; controle de acesso por instituição e por serviço/especialidade; trilha de auditoria de ações administrativas.</p>

<h2>9. Alterações</h2>
<p>Alterações relevantes desta política serão comunicadas no aplicativo, com atualização da data no topo desta página.</p>

<div class="footer">Escala+ — Gestão de plantões hospitalares · Esta página é servida diretamente pela plataforma e reflete o funcionamento real do sistema.</div>
</div>
</body>
</html>`;

privacyRouter.get(["/privacidade", "/privacy"], (_req: Request, res: Response) => {
  res.type("html").send(HTML);
});
