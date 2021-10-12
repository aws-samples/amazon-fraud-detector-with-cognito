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

"use strict";
const AWS = require('aws-sdk');
const ddb = new AWS.DynamoDB.DocumentClient();
const frauddetector = new AWS.FraudDetector({apiVersion: '2019-11-15'});

const payload = {
    "isBase64Encoded" : false,         
    headers: {
        "Access-Control-Allow-Headers" : "*",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*"
    }
};

exports.handler = async(event) => {
    // Set the user pool autoConfirmUser flag after validating the email domain
    console.log(event);

    //ip, useragent, state is optional in the request body
    //email is required
    const {ip, useragent, state, email} = JSON.parse(event.body);

    if(!email){
        payload["statusCode"] = 400;
        payload["body"] = JSON.stringify({error: "Email is required."});
        return payload; 
    }

    const sourceIP = (!ip)? event['requestContext']['identity']['sourceIp']: ip;
    const userAgent = (!useragent)? event['requestContext']['identity']['userAgent']: useragent;
    console.log(sourceIP, userAgent);

    const getParams = {
        TableName: process.env.USER_TABLE,
        KeyConditionExpression: 'EMAIL = :hkey',
        ExpressionAttributeValues: {
          ':hkey': email
        }
    };

    try {
        const tblResp = await ddb.query(getParams).promise();
        console.log(tblResp);

        if(tblResp['Count'] === 0){
            //respond with error since the record was not found in the table so something went wrong in the signup process
            payload["statusCode"] = 400;
            payload["body"] = JSON.stringify({error: "Unable to process request at this time. Please try again later."});
            return payload; 
        }else{
            const { Items } = tblResp;
            const userData = Items[0];
            let attemptUpd = {};
            const {
                    EMAIL: email_address,
                    IP_ADDRESS: ip_address,
                    USER_AGENT: user_agent,
                    BILLING_POSTAL: billing_postal,
                    PHONE_NUMBER: phone_number,
                    BILLING_ADDRESS: billing_address,
                    BILLING_STATE: billing_state,
                    AFD_OUTCOME: afd_outcome,
                    AFD_INSIGHT_SCORE: insight_score,
                    VERFICATION_ATTEMPTS: verification_attempts,
                    ATTEMPT_COUNT: attempt_count
                } = userData;

                if(verification_attempts === attempt_count){
                    //return error since total allowed attempts exhausted
                    const response = {
                                        code: 0, 
                                        message:`Oops! you've run out of allowed attempts to confirm your identity. Please contact us at support@octank.com.`,
                                        userData
                                    };
                    payload["statusCode"] = 200;
                    payload["body"] = JSON.stringify(response);
                    return payload;                    
                }else{
                    //update attempt_count
                    const incrementParams = {
                                                TableName: process.env.USER_TABLE,
                                                Key: {
                                                    'EMAIL': email
                                                },
                                                UpdateExpression: "set ATTEMPT_COUNT = ATTEMPT_COUNT + :val, LAST_UPDATE_TIMESTAMP = :dt",                        
                                                ExpressionAttributeValues:{
                                                    ":val": 1,
                                                    ":dt" : Date.now()
                                                },
                                                ReturnValues:"UPDATED_NEW"
                                            };

                    attemptUpd = await ddb.update(incrementParams).promise();
                    console.log(attemptUpd);
                }
            
                if(sourceIP !== ip_address || userAgent !== user_agent){
                    //AFD Prediction since IP Address or User Agent has changed
                    const params = {
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
                          'email_address': email_address,
                          'ip_address': sourceIP,       //possible new IP Address
                          'user_agent': userAgent,      //possible new user agent
                          'billing_postal': billing_postal,
                          'phone_number': phone_number,
                          'billing_address': billing_address,
                          'billing_state': billing_state
                          },
                        detectorVersionId: process.env.AFD_DETECTOR_VERSION
                      };
                      const res =  await frauddetector.getEventPrediction(params).promise();
                      const outcome = res['ruleResults'][0]['outcomes'][0];
                      const frauddetectorInsightScore = res['modelScores'][0]['scores']['sample_fraud_detection_model_insightscore'];

                      if(outcome !== afd_outcome || frauddetectorInsightScore !== insight_score){
                          //Update the dynamodb table if outcome or insight score is different
                          const updateParams = {
                                            TableName: process.env.USER_TABLE,
                                            Key: {
                                                'EMAIL': email
                                            },
                                            UpdateExpression: "set AFD_OUTCOME = :oc, AFD_INSIGHT_SCORE = :is, LAST_UPDATE_TIMESTAMP = :dt",                        
                                            ExpressionAttributeValues:{
                                                ":oc": outcome,
                                                ":is": frauddetectorInsightScore,
                                                ":dt": Date.now()
                                            },
                                            ReturnValues:"UPDATED_NEW"
                                        };
    
                        const updResp = await ddb.update(updateParams).promise();                        
                        console.log(updResp);
                      }

                      if(outcome === 'review_customer'){ 
                        //high risk -- return error
                        const response = {
                                            code: 0, 
                                            message:  `We are unable to verify your identity at this time. Please contact us at support@octank.com, so we can get this sorted out for you.`,
                                            userData: {...userData, ...attemptUpd['Attributes']}
                                        };
                        payload["statusCode"] = 200;
                        payload["body"] = JSON.stringify(response);
                        return payload; 
                      }else{ 
                        //either low risk or medium risk, user is already in middle of medium risk friction process
                        //return ok
                        const response = {
                                            code: 1, 
                                            message:  `OK`,
                                            userData: {...userData, ...attemptUpd['Attributes']}
                                        };
                        payload["statusCode"] = 200;
                        payload["body"] = JSON.stringify(response);
                        return payload; 
                      }

                }else{
                    //return ok since nothing changed
                    const response = {
                                        code: 1, 
                                        message:  `OK`,
                                        userData: {...userData, ...attemptUpd['Attributes']}
                                    };
                    payload["statusCode"] = 200;
                    payload["body"] = JSON.stringify(response);
                    return payload; 
                }            
        }
    } catch (error) {
        //return ok since nothing changed        
        console.log(error);
        payload["statusCode"] = 400;
        payload["body"] = JSON.stringify({error: "Unable to process request at this time. Please try again later."});
        return payload; 
    }
};