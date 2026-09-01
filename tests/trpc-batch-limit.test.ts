import {
  createTRPCUntypedClient,
  httpBatchLink,
  type TRPCFetch,
} from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

describe("limite de operações do lote tRPC", () => {
  it("divide seis queries em lotes de cinco e uma sem perder resultados", async () => {
    const batchSizes: number[] = [];
    const headerBatchSizes: number[] = [];
    const fetchMock = vi.fn<TRPCFetch>(async (input) => {
      const requestUrl = new URL(String(input));
      const paths = decodeURIComponent(requestUrl.pathname.split("/").at(-1)!)
        .split(",")
        .filter(Boolean);
      batchSizes.push(paths.length);

      return new Response(
        JSON.stringify(paths.map((path) => ({ result: { data: path } }))),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const client = createTRPCUntypedClient<AnyRouter>({
      links: [
        httpBatchLink({
          url: "https://escala.example/api/trpc",
          maxItems: 5,
          headers: ({ opList }) => {
            headerBatchSizes.push(opList.length);
            return {};
          },
          fetch: fetchMock,
        }),
      ],
    });

    const procedures = Array.from(
      { length: 6 },
      (_, index) => `procedure${index + 1}`,
    );
    const results = await Promise.all(
      procedures.map((procedure) => client.query(procedure)),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batchSizes).toEqual([5, 1]);
    expect(headerBatchSizes).toEqual([5, 1]);
    expect(results).toEqual(procedures);
  });
});
