import { getCollection } from '../config/database.js';
import {
  calculateTotal,
  createOrderDocument,
  generateOrderId,
  isValidStatusTransition,
} from '../utils/helper.js';

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

  // admin event ===================================>

  // admin login
  socket.on('adminLogin', async (data, callback) => {
    try {
      if (data.password === process.env.ADMIN_PASSWORD) {
        socket.isAdmin = true;
        socket.join('admins');
        console.log('Admin logged in:', socket.id);
        callback({
          success: true,
        });
      }
    } catch (error) {
      console.error('Admin login error', error);
      callback({
        success: false,
        message: error.message || 'Failed to login',
      });
    }
  });

  // get all orders for admin
  socket.on('getAllOrders', async (data, callback) => {
    try {
      if (!socket.isAdmin) {
        return callback({
          success: false,
          message: 'Unauthorized',
        });
      }
      const orderCollection = getCollection('orders');
      const filter = data?.status ? { status: data.status } : {};
      const orders = await orderCollection.find(filter).sort({ createdAt: -1 }).toArray();

      callback({
        success: true,
        orders,
      });
    } catch (error) {
      console.error('Get all orders error', error);
      callback({
        success: false,
        message: error.message || 'Failed to retrieve orders',
      });
    }
  });

  // order status update by admin
  socket.on('updateOrderStatus', async (data, callback) => {
    try {
      const orderCollection = getCollection('orders');
      const order = await orderCollection.findOne({ orderId: data.orderId });

      if (!order) {
        return callback({
          success: false,
          message: 'Order not found',
        });
      }

      if (!isValidStatusTransition(order.status, data.newStatus)) {
        return callback({
          success: false,
          message: `Invalid status transition from ${order.status} to ${data.newStatus}`,
        });
      }

      const result = await orderCollection.findOneAndUpdate(
        { orderId: data.orderId },
        {
          $set: {
            status: data.newStatus,
          },
          $push: {
            statusHistory: {
              status: data.newStatus,
              timestamp: new Date(),
              by: socket.id,
              note: data.note || `Status changed to ${data.newStatus}`,
            },
          },
        },
        { returnDocument: 'after' }
      );

      io.to(`order_${data.orderId}`).emit('orderStatusUpdated', {
        orderId: data.orderId,
        status: data.newStatus,
        order: result,
      });

      socket.to('admins').emit('orderStatusChanged', {
        orderId: data.orderId,
        status: data.newStatus,
      });

      callback({
        success: true,
        order: result,
      });
    } catch (error) {
      console.error('Update order status error', error);
      callback({
        success: false,
        message: error.message || 'Failed to update order status',
      });
    }
  });

  // accept order
  socket.on('acceptOrder', async (data, callback) => {
    try {
      if (!socket.isAdmin) {
        return callback({
          success: false,
          message: 'Unauthorized',
        });
      }

      const orderCollection = getCollection('orders');
      const order = await orderCollection.findOne({ orderId: data.orderId });

      if (!order || order.status !== 'pending') {
        return callback({
          success: false,
          message: 'Order not found or not pending',
        });
      }

      const estimatedTime = data.estimatedTime || 30;

      const result = await orderCollection.findOneAndUpdate(
        { orderId: data.orderId },
        {
          $set: {
            status: 'confirmed',
            estimatedTime,
          },
          $push: {
            statusHistory: {
              status: 'confirmed',
              timestamp: new Date(),
              by: socket.id,
              note: `Order accepted with estimated time ${estimatedTime} mins`,
            },
          },
        },
        { returnDocument: 'after' }
      );

      io.to(`order_${data.orderId}`).emit('orderAccepted', {
        orderId: data.orderId,
        estimatedTime,
      });

      socket.to('admins').emit('orderAccepted', {
        orderId: data.orderId,
      });

      callback({
        success: true,
        order: result,
      });
    } catch (error) {
      console.error('Accept order error', error);
      callback({
        success: false,
        message: error.message || 'Failed to accept order',
      });
    }
  });
};
export default orderHandler;
