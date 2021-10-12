/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

const AWS = require('aws-sdk');
const frauddetector = new AWS.FraudDetector({apiVersion: '2019-11-15'});
const ddb = new AWS.DynamoDB.DocumentClient();

exports.handler = async(event, context, callback) => {
    // Set the user pool autoConfirmUser flag after validating the email domain
    console.log(event);
    const {userAttributes} = event.request;
    event.response.autoConfirmUser = false;

    /**
     * Add Logic to validate disposable email domains
     * if email is a disposable email then -
     * 
     * var error = new Error("Sign-up using disposable emails not allowed");
     * callback(error, event);
     */

    /**
     * Add Logic to validate email tumbling and collusive signups
     * Add record to Amazon Netptune Fraud graph.Idenitfy any existing 
     * relationships with current emial userAttributes.email via graph traversal.
     * If relationships are found then throw error and perform any other actions 
     * necessary-
     * 
     * var error = new Error("Unable to register at this time");
     * callback(error, event);
     */

    var params = {
        detectorId: process.env.AFD_DETECTOR, 
        entities: [ 
          {
            entityId: `${Date.now()}`, 
            entityType: process.env.AFD_ENTITY_TYPE
          },
  
        ],
        eventId: `${Date.now()}`, 
        eventTimestamp: `${new Date().toISOString()}`,
        eventTypeName: process.env.AFD_EVENT_TYPE, 
        eventVariables: { 
          'email_address': userAttributes.email,
          'ip_address': userAttributes['custom:registration_ip'],
          'user_agent': userAttributes['custom:reg_user_agent'],
          'billing_postal': userAttributes['custom:billing_postal'],
          'phone_number': userAttributes.phone_number,
          'billing_address': userAttributes.address,
          'billing_state': userAttributes.locale
          },
        detectorVersionId: process.env.AFD_DETECTOR_VERSION
      };

      try {
        const res =  await frauddetector.getEventPrediction(params).promise();
        console.log("Outcome: ", res['ruleResults'][0]['outcomes'][0]);
        const outcome = res['ruleResults'][0]['outcomes'][0];
        const frauddetectorInsightScore = res['modelScores'][0]['scores']['sample_fraud_detection_model_insightscore'];

        //make an entry in DynamoDB
        const userObj = {
            'EMAIL': userAttributes.email,
            'IP_ADDRESS' : userAttributes['custom:registration_ip'],                                                       
            'USER_AGENT': userAttributes['custom:reg_user_agent'],
            'BILLING_ADDRESS': userAttributes.address,                    
            'BILLING_STATE': userAttributes.locale,
            'BILLING_POSTAL': userAttributes['custom:billing_postal'],
            'PHONE_NUMBER': userAttributes.phone_number,
            'AFD_OUTCOME': outcome,
            'AFD_INSIGHT_SCORE': frauddetectorInsightScore,
            'VERFICATION_ATTEMPTS': 3,
            'ATTEMPT_COUNT': 0,
            'TIMESTAMP': Date.now(),
            'LAST_UPDATE_TIMESTAMP': 0
        };

        const ddParams = {
          TableName: process.env.USER_TABLE,
          Item: userObj
        };

        await ddb.put(ddParams).promise();

        if(outcome === 'approve'){
            event.response.autoConfirmUser = true;
        }else if (outcome === 'review'){
            event.response.autoConfirmUser = false;
        }else{
            var error = new Error("- unable to verify identity");
            callback(error, event);
        }
      } catch (error) {
        callback(error, event);
      }    

    // Return to Amazon Cognito
    callback(null, event);
};
