export type NativeBadgeWriteResult<T> =
  | Readonly<{ state: "APPLIED"; value: T }>
  | Readonly<{ state: "STALE" }>;

type NativeBadgeWriteInput<T> = Readonly<{
  /** Must remain true until the platform write has completed. */
  isCurrent: () => boolean;
  /** The only place that calls the operating-system badge API. */
  write: () => Promise<T>;
}>;

// O badge é um único recurso do sistema operacional. Esta fila é process-wide
// por desenho: reconciliação, logout e uma sessão nova não podem concluir
// writes em ordem diferente daquela em que ganharam a capacidade de escrevê-lo.
let nativeBadgeWriteTail: Promise<void> = Promise.resolve();

export function enqueueNativeBadgeWrite<T>(
  input: NativeBadgeWriteInput<T>,
): Promise<NativeBadgeWriteResult<T>> {
  const scheduled = nativeBadgeWriteTail.then(async () => {
    // A validade precisa ser testada dentro da fila, não apenas quando o
    // caller agenda o trabalho: logout/rotação podem ocorrer enquanto aguarda.
    if (!input.isCurrent()) return { state: "STALE" } as const;
    const value = await input.write();
    return input.isCurrent()
      ? ({ state: "APPLIED", value } as const)
      : ({ state: "STALE" } as const);
  });

  // Uma falha da API nativa é devolvida ao caller, mas nunca pode interromper
  // a fila que protege a próxima sessão ou a limpeza de logout.
  nativeBadgeWriteTail = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}
