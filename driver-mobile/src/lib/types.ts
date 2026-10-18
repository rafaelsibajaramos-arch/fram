export type Lot = {
  reservationId: string;
  orderItemId: string;
  harvestBatchId: string;
  farmId: string;
  quantityKg: string | number;
  acceptedQuantityKg?: string | number | null;
  unitPrice?: string | number | null;
  pickupAddress: string;
};

export type Delivery = {
  id: string;
  orderId: string;
  deliveryAddress: string;
  windowStart: string;
  windowEnd: string;
  status: string;
  requiresColdChain: boolean;
  lots: Lot[];
};

export type Stop = {
  id: string;
  sequence: number;
  deliveryId: string;
  type: 'pickup' | 'dropoff';
  farmId?: string | null;
  address: string;
  plannedAt: string;
  actualAt?: string | null;
};

export type Route = {
  id: string;
  status: 'planned' | 'in_transit' | 'completed' | 'cancelled';
  scheduledDate: string;
  scheduledEnd: string;
  zone?: { name?: string; code?: string };
  vehicle?: { plate?: string; capacityKg?: string | number; refrigerated?: boolean };
  stops: Stop[];
  deliveries: Delivery[];
};
