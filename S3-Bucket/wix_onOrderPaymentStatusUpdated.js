import { fetch } from 'wix-fetch';

export async function onOrderPaymentStatusUpdated(event) {
  if (event.updatedPaymentStatus !== 'PAID') {
    console.log('Payment status not PAID, skipping');
    return;
  }

  const order = event.order;
  const orderId = order._id;
  const saleValue = order.priceSummary.total.amount;
  try {
    const additionalFields = order.additionalFields || [];
    const trackingField = additionalFields.find(field => field.fieldKey === 'trackingdata');

    if (!trackingField) {
      console.log('No tracking data in additionalFields');
      return;
    }
    const checkoutData = JSON.parse(trackingField.value);
    const { merchantId, referrerTag, referrerUrl, destinationUrl } = checkoutData;
    if (!merchantId || !referrerTag || !referrerUrl || !destinationUrl) {
      console.log('Incomplete checkout data');
      return;
    }
    console.log(`Retrieved checkout data: ${referrerTag}, ${referrerUrl}, merchantId: ${merchantId}, destinationUrl: ${destinationUrl}`);
    const url = 'https://stripe.clubmadeira.io';
    const payload = {
      distinct_id: merchantId,
      source: referrerTag,
      source_url: referrerUrl,
      destination: merchantId,
      destination_url: destinationUrl,
      order_id: orderId,
      sale_value: saleValue,
      timestamp: new Date().toISOString()
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log(`Request sent for orderId: ${orderId}`);
    } else {
      console.error('API error:', response.status);
    }
  } catch (error) {
    console.error('Error in onOrderPaymentStatusUpdated:', error);
  }
}