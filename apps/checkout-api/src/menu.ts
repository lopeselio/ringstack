export interface MenuItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** SOL, UI units. */
  readonly price: string;
}

export const SHOP_NAME = "Corner Café";

export const MENU: readonly MenuItem[] = [
  { id: "flat-white", name: "Flat white", description: "Double ristretto, steamed whole milk", price: "0.0125" },
  { id: "cortado", name: "Cortado", description: "Equal parts espresso and warm milk", price: "0.011" },
  { id: "cardamom-bun", name: "Cardamom bun", description: "Baked this morning", price: "0.008" },
];
