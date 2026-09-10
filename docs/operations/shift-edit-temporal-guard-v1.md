# Cerca temporal para edição de turnos V1

`shifts.update` rejeita com `CONFLICT` mudanças de horário ou modalidade
quando o turno original já iniciou ou quando o novo início não está no futuro.
A decisão é refeita dentro da transação, depois do bloqueio da linha e antes
da escrita, do rearme de confirmação e da emissão de duty-sync.

Edições que não alteram a janela nem a modalidade continuam sujeitas às
políticas existentes de tenant, escopo gerencial, mês e capacidade, mas não são
barradas por esta cerca. A V1 não altera schema, migrations nem dados existentes.
