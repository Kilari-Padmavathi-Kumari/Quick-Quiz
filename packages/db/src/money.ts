export function moneyToPaise(amount: string | number): number {
  const numericValue = typeof amount === "number" ? amount : Number(amount);

  if (!Number.isFinite(numericValue)) {
    throw new Error(`Invalid money value: ${amount}`);
  }

  return Math.round(numericValue * 100);
}

export function paiseToMoney(amountPaise: number): string {
  return (amountPaise / 100).toFixed(2);
}
