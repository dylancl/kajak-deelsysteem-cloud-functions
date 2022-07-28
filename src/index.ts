import { FirebaseError } from 'firebase-admin';
import * as functions from "firebase-functions";
import nodeFetch from 'node-fetch';
import { Stripe } from 'stripe';
import * as admin from 'firebase-admin';
admin.initializeApp();

const UITPAS_URL = 'https://account-test.uitid.be';
const UITPAS_API_URL = 'https://api-test.uitpas.be';
const EVENT_ID = '5a0967f9-cc06-4c3c-9206-30481a767434';

type FetchPaymentSheetParamsProps = {
    price: string;
    email: string;
    userId: string;
  };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
    apiVersion: '2020-08-27',
    typescript: true,
})

//FIXME: Add error handling
export const authenticate = functions.region('europe-west1').https.onCall(async (data, context) => {
    const request = await nodeFetch(UITPAS_URL + '/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: process.env.UITPAS_CLIENT_ID,
            client_secret: process.env.UITPAS_CLIENT_SECRET,
            audience: 'https://api.publiq.be',
        }),
    });

    const response = await request.json();

    return response;
});

export const fetchUitpasTarrifs = functions.region('europe-west1').https.onCall(async (data, context) => {
    const { uitpasNumber, accessToken, regularPrice } = data;

    if (!uitpasNumber || !accessToken || !regularPrice) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required parameters');
    }

    try {
        const request = await nodeFetch(`${UITPAS_API_URL}/tariffs/?eventId=${EVENT_ID}&uitpasNumber=${uitpasNumber}&regularPrice=${regularPrice}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + accessToken,
            },
        });
    
        const response = await request.json();
    
        return response;
    } catch (error) {
        console.log(error);
        throw new functions.https.HttpsError('internal', 'Something went wrong');
    }
});

type registerTicketSalesParamsProps = {
    uitpasNumber: string;
    accessToken: string;
    regularPrice: string;
    tariffId: string;
};

export const registerTicketSale = functions.region('europe-west1').https.onCall(async ({uitpasNumber, accessToken, tariffId, regularPrice}: registerTicketSalesParamsProps, context) => {
    if (!uitpasNumber || !accessToken || !tariffId || !regularPrice) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required parameters');
    }

    try {
        const request = await nodeFetch(`${UITPAS_API_URL}/ticket-sales`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + accessToken,
            },
            body: JSON.stringify([{
                eventId: EVENT_ID,
                uitpasNumber,
                tariff: {
                    id: tariffId,
                },
                regularPrice,
            }]),
        });

        const response = await request.json();

        return response;
    } catch (error) {
        console.log(error);
        throw new functions.https.HttpsError('internal', 'Something went wrong');
    }
});

type CancelTIcketSaleParamsProps = {
    ticketSaleId: string;
    accessToken: string;
}


export const cancelTicketSale = functions.region('europe-west1').https.onCall(async ({ticketSaleId, accessToken}: CancelTIcketSaleParamsProps, context) => {
    if (!ticketSaleId || !accessToken) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required parameters');
    }

    try {
        const request = await nodeFetch(`${UITPAS_API_URL}/ticket-sales/${ticketSaleId}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + accessToken,
            },
        });

        return !!request.ok;

    } catch (error) {
        console.log(error);
        throw new functions.https.HttpsError('internal', 'Something went wrong');
    }
});


export const fetchSubscriptionPaymentSheet = functions.region('europe-west1').https.onCall(async({ price, email, userId }: FetchPaymentSheetParamsProps, context) => {
    let customer: Stripe.Customer;
    
    const existingCustomer = await stripe.customers.list({
        email,
    }); 
    
    if (existingCustomer.data.length > 0) {
        customer = existingCustomer.data[0];
    }

    customer = await stripe.customers.create({
        email,  
        metadata: {
            'userId': userId,
        }
    });

    if (!price || !email || !userId) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required parameters');
    }

    console.log(`Creating a new subscription for ${email} with price ${price}`);

    try {
        const ephemeralKey = await stripe.ephemeralKeys.create(
            {customer: customer.id},
            {apiVersion: '2020-08-27'}
        );

        const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{price: price}],
            expand: ['latest_invoice.payment_intent'],
            payment_behavior: 'default_incomplete',
            metadata: {
                'userId': userId,
            }
        });

        if (!subscription.latest_invoice || typeof subscription.latest_invoice === 'string') {
            throw new Error('Subscription was created without an invoice. Please contact support.');
        }

        if (
            !subscription.latest_invoice.payment_intent ||
            typeof subscription.latest_invoice.payment_intent === 'string'
          ) {
            throw new Error(
              'Subscription was created without a payment intent. Please contact support.'
            );
          }
          
          return {
                paymentIntent: subscription.latest_invoice.payment_intent.client_secret,
                ephemeralKey: ephemeralKey.secret,
          }
    } catch (error) {
        console.error(error);
        throw new functions.https.HttpsError('unknown', (error as FirebaseError).message);
    }
});

export const fetchProductPaymentSheet = functions.region('europe-west1').https.onCall(async({ price, email, userId }: {price: number; email: string; userId: string}, context) => {
    let customer: Stripe.Customer;

    const existingCustomer = await stripe.customers.list({
        email,
    });

    if (existingCustomer.data.length > 0) {
        customer = existingCustomer.data[0];
    } else {
        customer = await stripe.customers.create({
            email,
            metadata: {
                'userId': userId,
            }
        });
    }

    if (!price) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with "price" as an argument.');
    }

    console.log(`Creating a new product for ${email} with price ${price}`);

    try {
        const ephemeralKey = await stripe.ephemeralKeys.create(
            {customer: customer.id},
            {apiVersion: '2020-08-27'}
        );

        const paymentIntent = await stripe.paymentIntents.create({
            customer: customer.id,
            amount: price,
            currency: 'eur',
            payment_method_types: ['card'],
            receipt_email: email,
            metadata: {
                'userId': userId,
            },
        });

        return {
            paymentIntent: paymentIntent.client_secret,
            ephemeralKey: ephemeralKey.secret,
        }

    } catch (error) {
        console.error(error);
        throw new functions.https.HttpsError('unknown', (error as FirebaseError).message);
    }
});
    

const confirmSubscription = async (event: Stripe.Event) => {
    const {customer} = event.data.object as Stripe.Subscription;

    if (!customer) {
        throw new Error('Subscription was created without a customer. Please contact support.');
    }
    // Get customer information from Stripe
    const customerInfo = await stripe.customers.retrieve(customer as string) as Stripe.Customer;

    const {userId} = customerInfo.metadata;

    if (!userId) {
        console.log('No userId found on subscription');
        return false;
    }

    const user = await admin.firestore().collection('users').where('userId', '==', userId).get();    

    if (user.empty) {
        console.log('No user found with userId', userId);
        return false;
    }

    const documentId = user.docs[0].id;

    const update = await admin.firestore().collection('users').doc(documentId).update({
        subscription: {
            active: true,
            startDate: admin.firestore.FieldValue.serverTimestamp(),
            subscription_id: 'test',
            stripe_customer_id: customer
        },
    });

    if (!update) {
        console.log('Could not update user with userId', userId);
        return false;
    }

    console.log('Subscription confirmed for user', userId);

    return true;
}

export const stripeWebhook = functions.region('europe-west1').https.onRequest(async (req, res) => {
    const body: Stripe.Event = req.body;

    if (body.type === 'charge.succeeded') {
        console.log('CheckProcessing payment intent succeeded event');
        const success = await confirmSubscription(body);
        
        if (success) {
            res.status(200).send('OK');
        } else {
            res.status(500).send('Something went wrong');
        }
    }
});

const generateCode = () => Math.floor(1000 + Math.random() * 9000);

export const generateNewCodes = functions.region('europe-west1').pubsub.schedule('every wednesday 00:00').onRun(async (context) => {
    const codes = await admin.firestore().collection('codes').doc('list').get();

    functions.logger.info(codes, codes.exists)

    if (codes.exists) {
        const list = codes.data() as string[];
        functions.logger.info(`Found ${list.length} codes`);
        const newCode = generateCode();
        list.shift();
        list.push(String(newCode));
        functions.logger.info(`Generated new code ${newCode}, new array: ${list}`);
        const update = await admin.firestore().collection('codes').doc('list').set(list);
       
        if (!update) {
            console.log('Could not update codes');
            return;
        }
    }

    

    console.log('Codes updated');
});

    

