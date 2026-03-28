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

  // track order
  socket.on('trackOrder', async (order, callback) => {
    try {
      const ordersCollection = getCollection('orders');
      const order = await ordersCollection.findOne({ orderId: data.orderId });
      if (!order) {
        return callback({ success: false, message: 'Order not found' });
      }
      socket.join(`order_${data.orderId}`);
      callback({
        success: true,
        order,
      });
    } catch (error) {
      console.error('Order tracking error', error);
      callback({
        success: false,
        message: error.message || 'Failed to track order',
      });
    }
  });

  // cancel order
  socket.on('cancelOrder', async (data, callback) => {
    try {
      const orderCollection = getCollection('orders');
      const order = await orderCollection.findOne({ orderId: data.orderId });
      if (!order) {
        return callback({ success: false, message: 'Order not found' });
      }
      if (!['pending', 'confirmed'].includes(order.status)) {
        return callback({ success: false, message: 'Order cannot be cancelled at this stage' });
      }

      await orderCollection.updateOne(
        { orderId: data.orderId },
        {
          $set: {
            status: 'cancelled',
            updatedAt: new Date(),
          },
          $push: {
            statusHistory: {
              status: 'cancelled',
              timestamp: new Date(),
              by: socket.id,
              note: data.reason || 'Order cancelled by customer',
            },
          },
        }
      );

      io.to(`order_${data.orderId}`).emit('orderCancelled', { orderId: data.orderId });
      io.to('admins').emit('orderCancelled', {
        orderId: data.orderId,
        customerName: order.customerName,
      });

      callback({
        success: true,
        message: 'Order cancelled successfully',
      });
    } catch (error) {
      console.error('Order cancellation error', error);
      callback({
        success: false,
        message: error.message || 'Failed to cancel order',
      });
    }
  });

  // get my orders
  socket.on('getMyOrders', async (data, callback) => {
    try {
      const ordersCollection = getCollection('orders');
      const orders = await ordersCollection
        .find({ customerPhone: data.customerPhone })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray();

      callback({
        success: true,
        orders,
      });
    } catch (error) {
      console.error('Get my orders error', error);
      callback({
        success: false,
        message: error.message || 'Failed to retrieve orders',
      });
    }
  });
};

export default orderHandler;
