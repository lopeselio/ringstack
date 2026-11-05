import { Checkout } from "./checkout";

export default function Page() {
  return (
    <main className="page">
      <header className="masthead">
        <h1>Corner Café</h1>
        <p>
          Order at the counter and pay privately. The amount and your order number travel encrypted; only the café can
          read them.
        </p>
      </header>
      <Checkout />
    </main>
  );
}
