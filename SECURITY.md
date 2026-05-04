# Security Policy

> **English summary at the bottom.**

## Sobre este projeto

**Escala / Comunica Escalas** é um sistema de gestão de escalas de plantões e
sobreavisos para uso clínico-operacional hospitalar. Não armazena prontuário
nem dados clínicos sensíveis (PHI). O escopo de segurança cobre:

- Autenticação e sessão de usuários hospitalares.
- Autorização institucional multi-tenant (isolamento entre hospitais).
- Integração com o sistema irmão **Comunica+** (notificações operacionais).
- Dados administrativos (vínculos profissionais, escalas, trocas).

## Como reportar uma vulnerabilidade

**Use o canal privado do GitHub** — não abra issue pública para vulnerabilidades.

1. Acesse a aba **Security** do repositório:
   <https://github.com/renosilveira-ui/arquivos-comunica-escala/security>
2. Clique em **Report a vulnerability** (Private vulnerability reporting).
3. Descreva:
   - O que conseguiu reproduzir (passo a passo).
   - Qual o impacto observado ou potencial (acesso indevido a dados,
     bypass de autorização, escalonamento de privilégio, etc.).
   - Versão / commit afetado (se possível).
   - Evidência: logs, payloads, screenshots, PoC mínimo.

Se o canal privado do GitHub não estiver disponível, abra uma issue com
título e corpo **genéricos** ("Possible security concern — contact
needed") e aguarde contato; **não inclua detalhes da vuln no corpo
público**.

## Tempo de resposta esperado

Este é um projeto mantido por equipe pequena. Compromisso de **best
effort**:

- **Acknowledgment** do recebimento: até 5 dias úteis.
- **Triagem inicial** (gravidade, escopo, plano): até 14 dias.
- **Correção** ou mitigação publicada: depende da gravidade.
  - Crítico (exposição de PII, bypass de autenticação, RCE): tratamento
    prioritário, em paralelo a outras frentes.
  - Alto: dentro do ciclo de release atual.
  - Médio/baixo: agendado conforme priorização.

## Escopo

### Em escopo
- Código deste repositório (`renosilveira-ui/arquivos-comunica-escala`).
- Configurações do GitHub Actions / CI definidas em `.github/`.
- Integração documentada com Comunica+ (`server/integrations/comunica-plus.ts`).

### Fora de escopo
- Vulnerabilidades exclusivamente do **Comunica+** — reportar diretamente
  no repositório <https://github.com/renosilveira-ui/Comunicamais>.
- Vulnerabilidades em dependências de terceiros — Dependabot já cobre.
  Reportar à upstream e, se houver impacto neste projeto, abrir advisory
  privado aqui.
- Configurações específicas de hospital cliente (deployment, secrets,
  rede). Reportar diretamente ao operador do hospital.
- Engenharia social, phishing, denial-of-service contra a infraestrutura
  do operador.

## Disclosure coordenada

Pedimos **disclosure coordenada**:

- Não publicar detalhes da vulnerabilidade até a correção ser
  publicada e operadores hospitalares notificados.
- Após correção, atribuição pública (nome, GitHub handle, link) é dada
  ao reporter, exceto quando solicitado anonimato.
- Janela típica entre report e disclosure pública: 90 dias, ou antes se
  a correção sair antes.

## Boas práticas para operadores

Se você opera uma instância deste sistema, leia também:

- [`.env.example`](.env.example) — todas as variáveis obrigatórias em
  produção, com avisos sobre os valores que **não devem** ser usados
  (`changeme`, `system123`, `9999`, etc.).
- [`docs/operations/scaling.md`](docs/operations/scaling.md) — limitações
  conhecidas de scaling horizontal.
- A frente de hardening implementada nos PRs #22, #23, #24, #25, #26 e
  #27 implementa: fail-fast em secrets fracos, helmet, rate limit, CORS
  hardening, payload limit, health check DB-aware, graceful shutdown,
  structured logger, cookie tightening.

## Histórico

Este arquivo foi adicionado em maio de 2026, como parte da Fase 3 de
guardrails GitHub do projeto. Antes desta data, não havia política
formal de disclosure.

---

## English summary

Report security vulnerabilities **privately** via GitHub Security
Advisories at
<https://github.com/renosilveira-ui/arquivos-comunica-escala/security>.

This is a hospital scheduling system (no PHI stored). Scope includes
authentication, multi-tenant authorization, and integration with the
sister project **Comunica+**. Best-effort SLA: acknowledgment within 5
business days; initial triage within 14 days; coordinated disclosure
within ~90 days. See above for details.
