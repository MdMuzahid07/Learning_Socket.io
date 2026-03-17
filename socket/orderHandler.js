import { getCollection } from '../config/database.js';
import { calculateTotal, createOrderDocument, generateOrderId } from '../utils/helper.js';

const orderHandler = (io, socket) => {
  console.log('📦 Order handler initialized for socket:', socket.id);

  // place order
  socket.on('placeOrder', async (data, callback) => {
    try {
      console.log('Received placeOrder from id:', socket.id, data);
      const validate = validateOrderData(data);
      if (!validate.valid) {
        return callback({
          success: false,
          message: validate.message,
        });
      }
      const totals = calculateTotal(data.items);
      const orderId = generateOrderId();
      const order = createOrderDocument(data, orderId, totals);

      const ordersCollection = getCollection('orders');
      await ordersCollection.insetOne(order);

      socket.join(`order_${orderId}`);
      socket.join('customers');
      io.to('admins').emit('newOrder', { order });

      callback({
        success: true,
        order,
      });

      console.log(`order created: ${orderId}`);
    } catch (error) {
      console.log('Error placing order:', error);
      callback({
        success: false,
        message: 'Failed to place order',
      });
    }
  });
};

export default orderHandler;
