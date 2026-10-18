import { aggregateOrderItems } from './orders.service';

describe('aggregateOrderItems', () => {
  it('suma las cantidades del mismo producto y conserva el orden de primera aparición', () => {
    const result = aggregateOrderItems([
      { productId: 'tomate', quantity: 4 },
      { productId: 'naranja', quantity: 2 },
      { productId: 'tomate', quantity: 6 },
    ]);
    expect(result).toEqual([
      { productId: 'tomate', quantity: 10 },
      { productId: 'naranja', quantity: 2 },
    ]);
  });

  it('no muta las líneas de entrada', () => {
    const items = [{ productId: 'tomate', quantity: 4 }, { productId: 'tomate', quantity: 6 }];
    aggregateOrderItems(items);
    expect(items.map((item) => item.quantity)).toEqual([4, 6]);
  });
});
