import { Text, TouchableOpacity, View } from "react-native";
import { useState } from "react";

interface MonthCalendarProps {
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
  shiftsPerDay?: Map<string, number>; // Mapa de "YYYY-MM-DD" -> quantidade de escalas
}

/**
 * MonthCalendar - Calendário mensal com grid de dias selecionáveis
 * 
 * Layout iOS-like:
 * - Grid 7x6 (semana x dias)
 * - Dia selecionado: fundo azul (#4DA3FF)
 * - Dias com escalas: indicador visual (ponto)
 * - Dias fora do mês: opacidade reduzida
 */
export function MonthCalendar({ selectedDate, onSelectDate, shiftsPerDay }: MonthCalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date(selectedDate));

  // Gerar dias do mês (incluindo dias do mês anterior/posterior para preencher grid)
  const generateCalendarDays = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    
    // Primeiro dia do mês
    const firstDay = new Date(year, month, 1);
    const firstDayOfWeek = firstDay.getDay(); // 0 = domingo
    
    // Último dia do mês
    const lastDay = new Date(year, month + 1, 0);
    const lastDate = lastDay.getDate();
    
    const days: Array<{ date: Date; isCurrentMonth: boolean }> = [];
    
    // Dias do mês anterior (para preencher início)
    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
      const date = new Date(year, month, -i);
      days.push({ date, isCurrentMonth: false });
    }
    
    // Dias do mês atual
    for (let day = 1; day <= lastDate; day++) {
      const date = new Date(year, month, day);
      days.push({ date, isCurrentMonth: true });
    }
    
    // Dias do próximo mês (para preencher final, até completar 42 dias = 6 semanas)
    const remainingDays = 42 - days.length;
    for (let day = 1; day <= remainingDays; day++) {
      const date = new Date(year, month + 1, day);
      days.push({ date, isCurrentMonth: false });
    }
    
    return days;
  };

  const days = generateCalendarDays();
  const weekDays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  const formatDateKey = (date: Date) => {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };

  const isSameDay = (date1: Date, date2: Date) => {
    return (
      date1.getFullYear() === date2.getFullYear() &&
      date1.getMonth() === date2.getMonth() &&
      date1.getDate() === date2.getDate()
    );
  };

  const isToday = (date: Date) => {
    return isSameDay(date, new Date());
  };

  const goToPreviousMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1));
  };

  const goToNextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1));
  };

  return (
    <View>
      {/* Header: Mês/Ano e navegação */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <TouchableOpacity onPress={goToPreviousMonth} style={{ padding: 8 }}>
          <Text style={{ fontSize: 20, color: "#4DA3FF" }}>‹</Text>
        </TouchableOpacity>
        
        <Text style={{ fontSize: 18, fontWeight: "600", color: "#FFFFFF" }}>
          {currentMonth.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}
        </Text>
        
        <TouchableOpacity onPress={goToNextMonth} style={{ padding: 8 }}>
          <Text style={{ fontSize: 20, color: "#4DA3FF" }}>›</Text>
        </TouchableOpacity>
      </View>

      {/* Dias da semana */}
      <View style={{ flexDirection: "row", marginBottom: 8 }}>
        {weekDays.map((day) => (
          <View key={day} style={{ flex: 1, alignItems: "center" }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: "rgba(255,255,255,0.5)" }}>
              {day}
            </Text>
          </View>
        ))}
      </View>

      {/* Grid de dias */}
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {days.map((item, index) => {
          const isSelected = isSameDay(item.date, selectedDate);
          const isTodayDate = isToday(item.date);
          const dateKey = formatDateKey(item.date);
          const hasShifts = shiftsPerDay && shiftsPerDay.has(dateKey);
          const shiftCount = hasShifts ? shiftsPerDay.get(dateKey) : 0;

          return (
            <TouchableOpacity
              key={index}
              onPress={() => onSelectDate(item.date)}
              style={{
                width: `${100 / 7}%`,
                aspectRatio: 1,
                alignItems: "center",
                justifyContent: "center",
                padding: 4,
              }}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: isSelected ? "#4DA3FF" : isTodayDate ? "rgba(77,163,255,0.2)" : "transparent",
                  borderWidth: isTodayDate && !isSelected ? 1 : 0,
                  borderColor: "#4DA3FF",
                }}
              >
                <Text
                  style={{
                    fontSize: 16,
                    fontWeight: isSelected || isTodayDate ? "600" : "400",
                    color: isSelected
                      ? "#FFFFFF"
                      : item.isCurrentMonth
                      ? "#FFFFFF"
                      : "rgba(255,255,255,0.3)",
                  }}
                >
                  {item.date.getDate()}
                </Text>
                
                {/* Indicador de escalas */}
                {hasShifts && shiftCount! > 0 && (
                  <View
                    style={{
                      position: "absolute",
                      bottom: 2,
                      width: 4,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: isSelected ? "#FFFFFF" : "#4DA3FF",
                    }}
                  />
                )}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}
