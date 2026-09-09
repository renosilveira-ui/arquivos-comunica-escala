# Contrato V1 — dados auxiliares da Agenda

## Feriados

`calendarAuxiliary.listHolidays` é uma API interna, account-wide e disponível
para toda conta autenticada. Ela não recebe instituição, hospital, setor,
papel, especialidade ou pacote comercial e não concede acesso a escalas.

O recorte V1 cobre Brasil e Ceará entre 2000 e 2100:

- feriados nacionais fixos previstos na legislação federal;
- Paixão de Cristo, calculada a partir da Páscoa e classificada conforme o
  calendário anual federal;
- 20 de novembro somente a partir da vigência da Lei nº 14.759/2023;
- 25 de março, Data Magna do Estado do Ceará;
- nenhum ponto facultativo ou feriado municipal.

Carnaval, Quarta-feira de Cinzas e Corpus Christi não são promovidos a feriado.
O cliente pode destacá-los futuramente com outra legenda, mas não em vermelho
como se fossem feriados deste contrato.

Fontes normativas conferidas nesta versão:

- [Lei nº 662/1949](https://www.planalto.gov.br/ccivil_03/leis/l0662.htm)
- [Lei nº 6.802/1980](https://www.planalto.gov.br/ccivil_03/leis/l6802.htm)
- [Lei nº 14.759/2023](https://legis.senado.leg.br/norma/38009421/publicacao/38014078)
- [Emenda Constitucional do Ceará nº 73/2011](https://www2.al.ce.gov.br/legislativo/legislacao5/const_e/ec73.htm)
- [Portaria MGI nº 11.460/2025, calendário federal de 2026](https://www.inca.gov.br/sites/ufu.sti.inca.local/files/media/document/ata_comite_de_governanca_02.02.2026_0.pdf)

O cálculo local é deliberado: uma tela de Agenda não deve depender da
disponibilidade, limite ou continuidade comercial de uma API pública gratuita
para saber se um dia é feriado. Mudanças legislativas exigem revisão deste
registro versionado e testes, em vez de serem aceitas silenciosamente de um
provedor externo.

## Clima

WeatherKit pertence a uma frente externa separada. Quando ativado, deverá:

- funcionar somente após consentimento de localização;
- arredondar a coordenada antes de enviá-la à Apple;
- nunca enviar conta, nome, e-mail ou topologia hospitalar;
- usar credenciais somente no servidor;
- cumprir atribuição da Apple e cache temporário limitado;
- falhar de forma isolada, sem impedir leitura ou edição da Agenda.
